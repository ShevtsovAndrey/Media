// === КОНФИГУРАЦИЯ (вставь свои данные) ===
const YANDEX_CONFIG = {
    region: 'ru-central1',
    endpoint: 'https://storage.yandexcloud.net',
    bucket: 'my-gallery-photos-777',      // ← ТВОЙ БАКЕТ
    accessKeyId: 'YCAJEdsduslR2tqI4X7bloeTg',        // ← ВСТАВЬ СЮДА
    secretAccessKey: 'YCNSa7x9zzWqAGzAI8Iyvv6j3475TIpIy7PGqEs5'     // ← ВСТАВЬ СЮДА
};

const GITHUB_CONFIG = {
    repo: 'ShevtsovAndrey/Media',
    branch: 'main',
    jsonPath: 'data/gallery.json'
};

// Инициализация AWS SDK v2
AWS.config.update({
    accessKeyId: YANDEX_CONFIG.accessKeyId,
    secretAccessKey: YANDEX_CONFIG.secretAccessKey,
    region: YANDEX_CONFIG.region,
    endpoint: YANDEX_CONFIG.endpoint,
    s3ForcePathStyle: true
});
const s3 = new AWS.S3();

// Очередь для синхронизации JSON (предотвращает гонку состояний)
let jsonSyncQueue = Promise.resolve();
function queueSyncJSON(changes, action) {
    jsonSyncQueue = jsonSyncQueue.then(() => syncJSON(changes, action)).catch(err => {
        console.error("❌ Ошибка синхронизации JSON:", err);
        alert("Не удалось обновить список фото. Проверь токен GitHub или интернет.");
    });
    return jsonSyncQueue;
}

// Проверка админа
const isAdmin = !!localStorage.getItem('github_token');
if (isAdmin) document.getElementById('addBtn').style.display = 'flex';

// === ЗАГРУЗКА ГАЛЕРЕИ С АВТОСИНХРОНИЗАЦИЕЙ ===
async function loadGallery() {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div class="loading">Загрузка и синхронизация...</div>';

    try {
        const token = localStorage.getItem('github_token');
        const jsonUrl = `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`;

        // 1. Получаем текущий JSON с GitHub
        const jsonRes = await fetch(jsonUrl, { headers: { 'Authorization': `token ${token}` } });
        let currentPhotos = [];
        let sha = null;
        
        if (jsonRes.ok) {
            const data = await jsonRes.json();
            currentPhotos = JSON.parse(atob(data.content));
            sha = data.sha;
        }

        // 2. Получаем список файлов из Яндекса
        const s3Files = await new Promise((resolve, reject) => {
            s3.listObjectsV2({ Bucket: YANDEX_CONFIG.bucket }, (err, data) => {
                if (err) reject(err);
                else resolve(data.Contents || []);
            });
        });

        const s3Keys = new Set(s3Files.map(f => f.Key));
        const jsonKeys = new Set(currentPhotos.map(p => p.key));

        // 3. Находим файлы в Яндексе, которых нет в JSON
        const missingInJson = s3Files
            .filter(f => !jsonKeys.has(f.Key))
            .map(f => ({
                title: f.Key.split('/').pop().replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
                key: f.Key
            }));

        // 4. Если есть расхождения — молча исправляем JSON
        if (missingInJson.length > 0) {
            console.log(`🔄 Автосинхронизация: +${missingInJson.length} файлов`);
            const updatedPhotos = [...currentPhotos, ...missingInJson];
            
            await fetch(jsonUrl, {
                method: 'PUT',
                headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'Auto-sync: recover missing photos',
                    content: btoa(JSON.stringify(updatedPhotos, null, 2)),
                    branch: GITHUB_CONFIG.branch,
                    sha
                })
            });
            currentPhotos = updatedPhotos;
        }

        // 5. Рендерим галерею из синхронизированного списка
        gallery.innerHTML = '';
        currentPhotos.forEach((photo, i) => renderCard(photo, i));

        if (currentPhotos.length === 0) {
            gallery.innerHTML = '<div class="loading">Нет фото. Нажми + чтобы добавить.</div>';
        }

    } catch (err) {
        console.error('❌ Ошибка загрузки:', err);
        // Фоллбэк: показываем хотя бы то, что есть в старом JSON
        try {
            const token = localStorage.getItem('github_token');
            const fallbackRes = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`, {
                headers: { 'Authorization': `token ${token}` }
            });
            if (fallbackRes.ok) {
                const data = await fallbackRes.json();
                const photos = JSON.parse(atob(data.content));
                gallery.innerHTML = '';
                photos.forEach((photo, i) => renderCard(photo, i));
            } else {
                gallery.innerHTML = '<div class="loading">Ошибка загрузки. Проверь интернет.</div>';
            }
        } catch {
            gallery.innerHTML = '<div class="loading">Ошибка. Попробуй позже.</div>';
        }
    }
}

// Рендер карточки
function renderCard(photo, index) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.dataset.key = photo.key;

    const imgUrl = `${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${photo.key}`;

    // Создаём img элемент программно — так безопаснее
const img = document.createElement('img');
img.src = imgUrl;
img.alt = photo.title;
img.loading = 'lazy';
img.style.cursor = 'pointer';

img.onerror = () => { card.style.display = 'none'; };

// iPhone требует и touch, и click
const openPhoto = (e) => {
    e.preventDefault();
    e.stopPropagation();
    openLightbox(imgUrl);
};

img.addEventListener('click', openPhoto);
img.addEventListener('touchstart', openPhoto, { passive: false });

    card.innerHTML = `
        ${isAdmin ? `<div class="delete-overlay"><button class="delete-btn" title="Удалить">&minus;</button></div>` : ''}
    `;
    
    card.appendChild(img); // Вставляем картинку в карточку

    if (isAdmin) {
        card.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deletePhoto(photo.key, photo.title, card);
        });
    }
    document.getElementById('gallery').appendChild(card);
}

// Кнопка "+"
document.getElementById('addBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

// Загрузка файлов (последовательно, с очередью)
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const btn = document.getElementById('addBtn');
    const originalText = btn.textContent;
    btn.textContent = '⏳';
    btn.disabled = true;

    for (const file of files) {
        try {
            const key = `${Date.now()}_${file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')}`;
            const title = file.name.split('.')[0];
            
            // 1. Загрузка в Яндекс
            await new Promise((resolve, reject) => {
                s3.upload({
                    Bucket: YANDEX_CONFIG.bucket,
                    Key: key,
                    Body: file,
                    ContentType: file.type
                }, (err, data) => err ? reject(err) : resolve(data));
            });

            console.log(`✅ ${file.name} → Яндекс`);

            // 2. ЖДЁМ сохранения в JSON перед успехом
            await syncJSON([{ title, key }], 'add');
            console.log(`✅ ${key} → gallery.json`);

            // 3. Только после успеха — показываем
            renderCard({ title, key }, -1);

        } catch (err) {
            console.error(`❌ Ошибка ${file.name}:`, err);
            alert(`Не удалось сохранить ${file.name}.`);
        }
    }

    btn.textContent = originalText;
    btn.disabled = false;
    e.target.value = '';
});

// Удаление фото
async function deletePhoto(key, title, cardElement) {
    if (!confirm(`Удалить "${title}"?`)) return;

    cardElement.style.opacity = '0.3';
    cardElement.style.pointerEvents = 'none';

    try {
        // 1. Удаление из Яндекса
        await new Promise((resolve, reject) => {
            s3.deleteObject({
                Bucket: YANDEX_CONFIG.bucket,
                Key: key
            }, (err, data) => err ? reject(err) : resolve(data));
        });

        console.log(`✅ ${key} удалён из Яндекса`);

        // 2. Удаление из JSON
        await queueSyncJSON([{ key }], 'delete');

        // 3. Удаление из DOM
        cardElement.remove();

    } catch (err) {
        console.error(`❌ Ошибка удаления:`, err);
        alert(`Не удалось удалить: ${err.code || err.message}`);
        cardElement.style.opacity = '1';
        cardElement.style.pointerEvents = 'auto';
    }
}

// Синхронизация с GitHub (с ретраем при конфликте sha)
async function syncJSON(changes, action, retries = 2) {
    const token = localStorage.getItem('github_token');
    const url = `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}`;

    const getRes = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
    if (!getRes.ok) throw new Error('Не удалось получить gallery.json');
    
    const data = await getRes.json();
    let current = [];
    try { current = JSON.parse(atob(data.content)); } catch(e) { current = []; }
    const sha = data.sha;

    if (action === 'add') current.push(...changes);
    else current = current.filter(p => p.key !== changes[0].key);

    const putRes = await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: action === 'add' ? 'Add photo' : 'Delete photo',
            content: btoa(JSON.stringify(current, null, 2)),
            branch: GITHUB_CONFIG.branch,
            sha
        })
    });

    if (!putRes.ok) {
        const errData = await putRes.json().catch(() => ({}));
        if (putRes.status === 422 && retries > 0) {
            console.warn('⚠️ Конфликт sha, повтор...');
            await new Promise(r => setTimeout(r, 1000));
            return syncJSON(changes, action, retries - 1);
        }
        throw new Error(errData.message || `GitHub API error ${putRes.status}`);
    }
}
// === ПОЛНОЭКРАННЫЙ ПРОСМОТР (рабочая версия для iOS + Desktop) ===
function openLightbox(imgUrl) {
    // Проверяем, есть ли уже лайтбокс
    let lb = document.getElementById('lightbox');
    if (lb) {
        // Если есть — просто меняем фото
        const img = lb.querySelector('img');
        img.style.opacity = '0';
        setTimeout(() => {
            img.src = imgUrl;
            img.onload = () => {
                img.style.opacity = '1';
            };
        }, 200);
        lb.classList.add('active');
        return;
    }
    
    // Создаём новый
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = '<img src="" alt="">';
    document.body.appendChild(lb);
    
    // Закрытие
    const close = () => {
        lb.classList.remove('active');
        setTimeout(() => lb.remove(), 200);
    };
    
    lb.addEventListener('click', close);
    
    // Esc
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape' && document.getElementById('lightbox')) {
            close();
            document.removeEventListener('keydown', onEsc);
        }
    });
    
    // Показ
    const img = lb.querySelector('img');
    img.src = imgUrl;
    
    // Форсируем reflow
    requestAnimationFrame(() => {
        if (img.complete) {
            img.style.opacity = '1';
            lb.classList.add('active');
        } else {
            img.onload = () => {
                img.style.opacity = '1';
                lb.classList.add('active');
            };
        }
    });
}

window.openLightbox = openLightbox;
// Старт
loadGallery();