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

//ФУНКЦИЯ ЧТЕНИЯ EXIF
function getExifDate(file) {
    return new Promise((resolve) => {
        // Если файл не JPEG, EXIF скорее всего нет → сразу fallback
        if (!file.type.includes('jpeg') && !file.type.includes('jpg')) {
            return resolve(file.lastModified);
        }

        EXIF.getData(file, function () {
            const dateTaken = EXIF.getTag(this, 'DateTimeOriginal') || EXIF.getTag(this, 'CreateDate');
            if (dateTaken) {
                // EXIF формат: "YYYY:MM:DD HH:MM:SS" → превращаем в валидный Date
                const clean = dateTaken.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
                resolve(new Date(clean).getTime());
            } else {
                resolve(file.lastModified); // Fallback на дату изменения файла
            }
        });
    });
}

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

async function uploadFiles(files) {
    console.log(' Drag&Drop: получены файлы', files);
    console.log('🔧 s3:', typeof s3);
    console.log('🔧 syncJSON:', typeof syncJSON);
    
    if (!files || files.length === 0) return;

    const btn = document.getElementById('addBtn');
    const originalText = btn ? btn.textContent : '';
    if (btn) { btn.textContent = '⏳'; btn.disabled = true; }

 for (const file of files) {
        try {
            const key = `${Date.now()}_${file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')}`;
            const title = file.name.split('.')[0];
            
            // 1. Считываем EXIF дату
            console.log(`📖 Читаю метаданные ${file.name}...`);
            const photoDate = await getExifDate(file);
            
            // 2. Кэшируем дату в браузере (чтобы сортировка потом была мгновенной)
            localStorage.setItem(`exif_date_${key}`, photoDate);
            console.log(`💾 Дата сохранена: ${new Date(photoDate).toLocaleDateString()}`);

            // 3. Загрузка в Яндекс
            await new Promise((resolve, reject) => {
                s3.upload({
                    Bucket: YANDEX_CONFIG.bucket,
                    Key: key,
                    Body: file,
                    ContentType: file.type
                }, (err, data) => err ? reject(err) : resolve(data));
            });

            console.log(`✅ ${file.name} → Яндекс`);

            // 4. Сохраняем в JSON вместе с датой
            await syncJSON([{ title, key, date: photoDate }], 'add');
            console.log(`✅ ${key} → gallery.json`);

            // 5. Показываем
            renderCard({ title, key }, -1);

        } catch (err) {
            console.error(`❌ Ошибка ${file.name}:`, err);
            alert(`Не удалось сохранить ${file.name}.`);
        }
    }

    if (btn) { btn.textContent = originalText; btn.disabled = false; }
}

// === ЗАГРУЗКА ГАЛЕРЕИ С АВТОСИНХРОНИЗАЦИЕЙ ===
async function loadGallery() {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div class="loading">Загрузка</div>';

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

               // === DEBUG: проверка дат ===
            console.log('🔍 Проверка дат в фото:');
            currentPhotos.slice(0, 5).forEach(p => {
                console.log(`  ${p.key}: date=${p.date}, parsed=${p.date ? new Date(p.date).getFullYear() : 'нет'}`);
            });
            // === КОНЕЦ DEBUG ===

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

if (sortMode !== 'default') {
    renderSortedGallery(currentPhotos); // ← Передаём массив!
} else {
    currentPhotos.forEach(photo => renderCard(photo, -1));
}


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

    // Создаём img элемент
    const img = document.createElement('img');
    img.src = imgUrl;
    img.alt = photo.title;
    img.loading = 'lazy';
    img.style.cursor = 'pointer';

    img.onerror = () => { card.style.display = 'none'; };

    // Переменные для отслеживания касания
    let touchStartX = 0;
    let touchStartY = 0;

    // 1. Запоминаем где коснулись (НЕ открываем лайтбокс сразу!)
    img.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX;
        touchStartY = e.touches[0].clientY;
    }, { passive: true });

    // 2. При отпускании проверяем: если сдвиг < 15px — это тап
    img.addEventListener('touchend', (e) => {
        const deltaX = Math.abs(e.changedTouches[0].clientX - touchStartX);
        const deltaY = Math.abs(e.changedTouches[0].clientY - touchStartY);

        // Если палец почти не двигался — открываем лайтбокс
        if (deltaX < 15 && deltaY < 15) {
            e.preventDefault();
            e.stopPropagation();
            openLightbox(imgUrl);
        }
        // Если двигался — это скролл, ничего не делаем
    }, { passive: false });

    // 3. Для компьютера — обычный клик
    img.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        openLightbox(imgUrl);
    });

    card.innerHTML = `
        ${isAdmin ? `<div class="delete-overlay"><button class="delete-btn" title="Удалить">&minus;</button></div>` : ''}
    `;
    
    card.appendChild(img);

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
    await uploadFiles(files); // ← Используем общую функцию
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
// === ПОЛНОЭКРАННЫЙ ПРОСМОТР ЛАЙТБОКС (рабочая версия для iOS + Desktop) ===
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




// СОРТИРОВКА ГАЛЕРЕИ ПО КНОПКЕ (ТЕСТ)

// === СОРТИРОВКА ГАЛЕРЕИ ===
let sortMode = localStorage.getItem('gallerySortMode') || 'default';
const sortBtn = document.getElementById('sortBtn');
const photoMetaCache = JSON.parse(localStorage.getItem('photoMetaCache') || '{}');

// Обновляем иконку кнопки
function updateSortIcon() {
    if (!sortBtn) return;
    const icons = { default: '🔄', date: '📅', color: '🎨' };
    sortBtn.textContent = icons[sortMode];
}
updateSortIcon();

// Переключение режима
if (sortBtn) {
    sortBtn.addEventListener('click', async () => {
        const modes = ['default', 'date', 'color'];
        const idx = modes.indexOf(sortMode);
        sortMode = modes[(idx + 1) % modes.length];
        localStorage.setItem('gallerySortMode', sortMode);
        updateSortIcon();
        
        // Получаем актуальные фото из JSON (быстро, из кэша браузера)
        try {
            const token = localStorage.getItem('github_token');
            const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`, {
                headers: { 'Authorization': `token ${token}` }
            });
            if (res.ok) {
                const data = await res.json();
                const photos = JSON.parse(atob(data.content));
                renderSortedGallery(photos); // ← Передаём массив
            }
        } catch(e) {
            console.error('Ошибка при сортировке:', e);
        }
    });
}

// Получение даты из имени файла (IMG_20250306_...) или кэша
function getPhotoDate(key) {
    if (photoMetaCache[key]?.date) return new Date(photoMetaCache[key].date);
    const match = key.match(/(\d{4})(\d{2})(\d{2})/);
    const date = match ? new Date(`${match[1]}-${match[2]}-${match[3]}`) : new Date();
    photoMetaCache[key] = photoMetaCache[key] || {};
    photoMetaCache[key].date = date.toISOString();
    localStorage.setItem('photoMetaCache', JSON.stringify(photoMetaCache));
    return date;
}

// Получение доминирующего цвета (Hue 0-360)
async function getPhotoHue(key, imgUrl) {
    if (photoMetaCache[key]?.hue !== undefined) return photoMetaCache[key].hue;
    
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            canvas.width = 50; canvas.height = 50;
            ctx.drawImage(img, 0, 0, 50, 50);
            
            const data = ctx.getImageData(20, 20, 10, 10).data;
            let r = 0, g = 0, b = 0, count = 0;
            for (let i = 0; i < data.length; i += 4) {
                r += data[i]; g += data[i+1]; b += data[i+2]; count++;
            }
            r /= count; g /= count; b /= count;
            
            // RGB -> HSL -> Hue
            const max = Math.max(r,g,b), min = Math.min(r,g,b);
            let h = 0;
            if (max !== min) {
                const d = max - min;
                if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
                else if (max === g) h = ((b - r) / d + 2) / 6;
                else h = ((r - g) / d + 4) / 6;
            }
            const hue = Math.round(h * 360);
            photoMetaCache[key] = photoMetaCache[key] || {};
            photoMetaCache[key].hue = hue;
            localStorage.setItem('photoMetaCache', JSON.stringify(photoMetaCache));
            resolve(hue);
        };
        img.onerror = () => resolve(0);
        img.src = imgUrl;
    });
}

// Основная функция перерисовки с сортировкой
// === СОРТИРОВКА (исправленная: без повторных запросов, с EXIF-датами) ===
// === СОРТИРОВКА (с разделением на "известные" и "неизвестные" даты) ===
async function renderSortedGallery(photosSource) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div class="loading">Сортировка...</div>';
    await new Promise(r => setTimeout(r, 30));

    let photos = Array.isArray(photosSource) ? [...photosSource] : [];
    if (photos.length === 0) {
        gallery.innerHTML = '<div class="loading">Нет фото</div>';
        return;
    }

    // === РАЗДЕЛЯЕМ фото на "с датой" и "без даты" ===
    const photosWithDate = [];
    const photosWithoutDate = [];
    
    photos.forEach(photo => {
        // Проверяем, что дата есть и валидна
        if (photo.date && !isNaN(new Date(photo.date).getTime())) {
            const year = new Date(photo.date).getFullYear();
            // Отбрасываем абсурдные годы (меньше 2000)
            if (year >= 2000 && year <= 2100) {
                photosWithDate.push(photo);
            } else {
                photosWithoutDate.push(photo);
            }
        } else {
            photosWithoutDate.push(photo);
        }
    });

    // === СОРТИРОВКА фото с датами ===
    if (sortMode === 'date') {
        photosWithDate.sort((a, b) => {
            const dateA = new Date(a.date).getTime();
            const dateB = new Date(b.date).getTime();
            return dateB - dateA; // Новые → старые
        });
    } else if (sortMode === 'color') {
        const withHue = await Promise.all(photosWithDate.map(async p => {
            const cacheKey = `hue_${p.key}`;
            let hue = localStorage.getItem(cacheKey);
            if (hue === null) {
                const imgUrl = `${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${p.key}`;
                hue = await getPhotoHueSimple(imgUrl);
                localStorage.setItem(cacheKey, hue);
            }
            return { ...p, hue: parseInt(hue) };
        }));
        withHue.sort((a, b) => {
            const shift = (h) => (h + 330) % 360;
            return shift(a.hue) - shift(b.hue);
        });
        photosWithDate.splice(0, photosWithDate.length, ...withHue);
    }

    // === РЕНДЕР ===
    gallery.innerHTML = '';
    
    // 1. Сначала рендерим "Неизвестные данные" (ТОЛЬКО АДМИНУ)
    if (isAdmin && photosWithoutDate.length > 0) {
        const unknownHeader = document.createElement('div');
        unknownHeader.className = 'year-header unknown-header';
        unknownHeader.textContent = '📁 Неизвестные данные';
        gallery.appendChild(unknownHeader);
        
        photosWithoutDate.forEach(photo => {
            renderCard(photo, -1, true); // true = это фото без даты
        });
    }
    
    // 2. Потом рендерим фото с датами (с группировкой по годам)
    if (photosWithDate.length > 0) {
        let lastYear = null;
        
        photosWithDate.forEach(photo => {
            if (sortMode === 'date') {
                const year = new Date(photo.date).getFullYear().toString();
                
                if (year !== lastYear) {
                    const header = document.createElement('div');
                    header.className = 'year-header';
                    header.textContent = year;
                    gallery.appendChild(header);
                    lastYear = year;
                }
            }
            
            renderCard(photo, -1, false);
        });
    }
    
    console.log(`✅ Отсортировано: ${photosWithDate.length} с датой, ${photosWithoutDate.length} без даты`);
}
// === ЛЁГКИЙ АНАЛИЗ ЦВЕТА (10×10 пикселей, ~20мс на фото) ===
function getPhotoHueSimple(imgUrl) {
    return new Promise(resolve => {
        const img = new Image();
        img.crossOrigin = "Anonymous";
        img.onload = () => {
            const c = document.createElement('canvas');
            c.width = 10; c.height = 10;
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, 10, 10);
            const d = ctx.getImageData(0, 0, 10, 10).data;
            
            let r=0, g=0, b=0, n=0;
            for(let i=0; i<d.length; i+=4) { r+=d[i]; g+=d[i+1]; b+=d[i+2]; n++; }
            r/=n; g/=n; b/=n;
            
            const max=Math.max(r,g,b), min=Math.min(r,g,b), delta=max-min;
            let h=0;
            if(delta!==0){
                if(max===r) h=((g-b)/delta+(g<b?6:0))/6;
                else if(max===g) h=((b-r)/delta+2)/6;
                else h=((r-g)/delta+4)/6;
            }
            resolve(Math.round(h*360));
        };
        img.onerror = () => resolve(0);
        img.src = imgUrl;
    });
}


// === DRAG & DROP (Ждёт загрузки страницы) ===
window.addEventListener('load', () => {
    const dragOverlay = document.getElementById('dragOverlay');
    
    if (!dragOverlay) {
        console.error('❌ ОШИБКА: Элемент #dragOverlay не найден в HTML! Проверь index.html');
        return; // Останавливаемся, чтобы не ломать остальное
    }

    console.log('✅ Drag&Drop инициализирован');

    // 1. Блокируем стандартное открытие файла браузером
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        }, false);
    });

    // 2. Показываем оверлей
    document.addEventListener('dragenter', () => {
        dragOverlay.classList.add('active');
        console.log('👁️ Оверлей показан');
    }, false);

    // 3. Скрываем, если увели мышку за окно
    document.addEventListener('dragleave', (e) => {
        // Проверяем, что ушли именно за пределы окна, а не на другой элемент
        if (e.clientX === 0 && e.clientY === 0) {
            dragOverlay.classList.remove('active');
            console.log('🙈 Оверлей скрыт');
        }
    }, false);

    // 4. Обработка броска
    document.addEventListener('drop', async (e) => {
        dragOverlay.classList.remove('active');
        
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        
        if (files.length === 0) {
            console.warn('⚠️ Файлы не найдены или не являются изображениями');
            return;
        }

        console.log(`📥 Получено файлов: ${files.length}`);
        console.log('Первый файл:', files[0].name, files[0].size, 'bytes');

        // Вызываем ТВОЮ функцию uploadFiles
        if (typeof uploadFiles === 'function') {
            await uploadFiles(files);
        } else {
            console.error('❌ Функция uploadFiles не найдена!');
        }
    }, false);
});



// Старт
loadGallery();