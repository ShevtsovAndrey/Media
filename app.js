// === КОНФИГУРАЦИЯ ===
const YANDEX_CONFIG = {
    region: 'ru-central1',
    endpoint: 'https://storage.yandexcloud.net',
    bucket: 'my-gallery-photos-777',
    accessKeyId: 'YCAJEdsduslR2tqI4X7bloeTg',
    secretAccessKey: 'YCNSa7x9zzWqAGzAI8Iyvv6j3475TIpIy7PGqEs5'
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

// Очередь для синхронизации JSON
let jsonSyncQueue = Promise.resolve();
function queueSyncJSON(changes, action) {
    jsonSyncQueue = jsonSyncQueue.then(() => syncJSON(changes, action)).catch(err => {
        console.error("❌ Ошибка синхронизации JSON:", err);
        alert("Не удалось обновить список фото.");
    });
    return jsonSyncQueue;
}

// Проверка админа
const isAdmin = !!localStorage.getItem('github_token');
if (isAdmin) document.getElementById('addBtn').style.display = 'flex';

// === ОБЩАЯ ФУНКЦИЯ ЗАГРУЗКИ (для + и drag&drop) ===
async function uploadFiles(files) {
    if (!files || files.length === 0) return;

    const btn = document.getElementById('addBtn');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

    for (const file of files) {
        try {
            const key = `${Date.now()}_${file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')}`;
            const title = file.name.split('.')[0];
            
            // Загрузка в Яндекс
            await new Promise((resolve, reject) => {
                s3.upload({
                    Bucket: YANDEX_CONFIG.bucket,
                    Key: key,
                    Body: file,
                    ContentType: file.type
                }, (err, data) => err ? reject(err) : resolve(data));
            });

            console.log(`✅ ${file.name} → Яндекс`);

            // Сохранение в JSON
            await syncJSON([{ title, key }], 'add');
            console.log(`✅ ${key} → gallery.json`);

            // Показ на странице
            renderCard({ title, key }, -1);

        } catch (err) {
            console.error(`❌ Ошибка ${file.name}:`, err);
            alert(`Не удалось загрузить ${file.name}`);
        }
    }

    if (btn) { btn.textContent = originalText; btn.disabled = false; }
}

// === ЗАГРУЗКА ГАЛЕРЕИ ===
async function loadGallery() {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div class="loading">Загрузка и синхронизация...</div>';

    try {
        const token = localStorage.getItem('github_token');
        const jsonUrl = `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`;

        const jsonRes = await fetch(jsonUrl, { headers: { 'Authorization': `token ${token}` } });
        let currentPhotos = [];
        
        if (jsonRes.ok) {
            const data = await jsonRes.json();
            currentPhotos = JSON.parse(atob(data.content));
        }

        // Автосинхронизация с Яндексом
        const s3Files = await new Promise((resolve, reject) => {
            s3.listObjectsV2({ Bucket: YANDEX_CONFIG.bucket }, (err, data) => {
                if (err) reject(err);
                else resolve(data.Contents || []);
            });
        });

        const jsonKeys = new Set(currentPhotos.map(p => p.key));
        const missingInJson = s3Files
            .filter(f => !jsonKeys.has(f.Key))
            .map(f => ({
                title: f.Key.split('/').pop().replace(/\.[^/.]+$/, '').replace(/_/g, ' '),
                key: f.Key
            }));

        if (missingInJson.length > 0 && token) {
            console.log(`🔄 Автосинхронизация: +${missingInJson.length} файлов`);
            const updatedPhotos = [...currentPhotos, ...missingInJson];
            const getRes = await fetch(jsonUrl, { headers: { 'Authorization': `token ${token}` } });
            const sha = getRes.ok ? (await getRes.json()).sha : null;
            
            await fetch(jsonUrl, {
                method: 'PUT',
                headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: 'Auto-sync',
                    content: btoa(JSON.stringify(updatedPhotos, null, 2)),
                    branch: GITHUB_CONFIG.branch,
                    sha
                })
            });
            currentPhotos = updatedPhotos;
        }

        gallery.innerHTML = '';
        currentPhotos.forEach((photo, i) => renderCard(photo, i));
        if (currentPhotos.length === 0) {
            gallery.innerHTML = '<div class="loading">Нет фото</div>';
        }
    } catch (err) {
        console.error('❌ Ошибка загрузки:', err);
        gallery.innerHTML = '<div class="loading">Ошибка</div>';
    }
}

// Рендер карточки (без изменений — лайтбокс и удаление работают)
function renderCard(photo, index) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.dataset.key = photo.key;
    const imgUrl = `${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${photo.key}`;

    const img = document.createElement('img');
    img.src = imgUrl;
    img.alt = photo.title;
    img.loading = 'lazy';
    img.style.cursor = 'pointer';
    img.onerror = () => { card.style.display = 'none'; };

    // Touch для мобильных
    let touchStartX = 0, touchStartY = 0;
    img.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });

    img.addEventListener('touchend', (e) => {
        const deltaX = Math.abs(e.changedTouches[0].clientX - touchStartX);
        const deltaY = Math.abs(e.changedTouches[0].clientY - touchStartY);
        if (deltaX < 15 && deltaY < 15) {
            e.preventDefault();
            e.stopPropagation();
            openLightbox(imgUrl);
        }
    }, { passive: false });

    // Клик для десктопа
    img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(imgUrl);
    });

    // Сначала картинка
    card.appendChild(img);

    // Потом overlay удаления (поверх)
    if (isAdmin) {
        const overlay = document.createElement('div');
        overlay.className = 'delete-overlay';
        overlay.innerHTML = `<button class="delete-btn" title="Удалить">&minus;</button>`;
        overlay.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deletePhoto(photo.key, photo.title, card);
        });
        card.appendChild(overlay);
    }

    document.getElementById('gallery').appendChild(card);
}

// Кнопка "+" → открывает fileInput
document.getElementById('addBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

// Загрузка через fileInput → используем общую функцию
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    await uploadFiles(files);
    e.target.value = '';
});

// === DRAG & DROP (исправленный, без DOMContentLoaded) ===
if (isAdmin) {
    const dragOverlay = document.getElementById('dragOverlay');
    
    if (dragOverlay) {
        let dragCounter = 0;

        document.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;
            dragOverlay.classList.add('active');
        });

        document.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;
            if (dragCounter === 0) dragOverlay.classList.remove('active');
        });

        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        document.addEventListener('drop', async (e) => {
            e.preventDefault();
            dragCounter = 0;
            dragOverlay.classList.remove('active');

            const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
            if (files.length > 0) {
                await uploadFiles(files); // ← Единая функция!
            }
        });
    }
}

// Удаление фото (без изменений)
async function deletePhoto(key, title, cardElement) {
    if (!confirm(`Удалить "${title}"?`)) return;
    cardElement.style.opacity = '0.3';
    cardElement.style.pointerEvents = 'none';

    try {
        await new Promise((resolve, reject) => {
            s3.deleteObject({ Bucket: YANDEX_CONFIG.bucket, Key: key }, (err, data) => err ? reject(err) : resolve(data));
        });
        await queueSyncJSON([{ key }], 'delete');
        cardElement.remove();
    } catch (err) {
        console.error('❌ Ошибка удаления:', err);
        alert(`Не удалось удалить: ${err.code || err.message}`);
        cardElement.style.opacity = '1';
        cardElement.style.pointerEvents = 'auto';
    }
}

// Синхронизация с GitHub (без изменений)
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

// Лайтбокс (без изменений — работает)
function openLightbox(imgUrl) {
    let lb = document.getElementById('lightbox');
    if (lb) {
        const img = lb.querySelector('img');
        img.style.opacity = '0';
        setTimeout(() => {
            img.src = imgUrl;
            img.onload = () => { img.style.opacity = '1'; };
        }, 200);
        lb.classList.add('active');
        return;
    }
    
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.className = 'lightbox';
    lb.innerHTML = '<img src="" alt="">';
    document.body.appendChild(lb);
    
    const close = () => {
        lb.classList.remove('active');
        setTimeout(() => lb.remove(), 200);
    };
    lb.addEventListener('click', close);
    
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape' && document.getElementById('lightbox')) {
            close();
            document.removeEventListener('keydown', onEsc);
        }
    });
    
    const img = lb.querySelector('img');
    img.src = imgUrl;
    
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