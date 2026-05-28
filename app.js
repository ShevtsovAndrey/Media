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

//Сортировка для всех пользователей
window.galleryPhotos = [];

// Хелпер: возвращает год для сортировки (Тег > EXIF > null)
function getSortYear(photo) {
    if (photo.tagYear) return photo.tagYear;
    if (photo.date && !isNaN(new Date(photo.date).getTime())) return new Date(photo.date).getFullYear();
    return null;
}




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
const originalHTML = btn ? btn.innerHTML : ''; // Запоминаем исходную иконку "+"
if (btn) {
    btn.innerHTML = '<img src="loader.png" class="loading-icon">';
    btn.disabled = true;
}

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
            const year = photoDate ? new Date(photoDate).getFullYear() : null;
await syncJSON([{ title, key, date: photoDate, tagYear: year }], 'add');
            console.log(`✅ ${key} → gallery.json`);

            // 5. Показываем
            renderCard({ title, key }, -1);

        } catch (err) {
            console.error(`❌ Ошибка ${file.name}:`, err);
            alert(`Не удалось сохранить ${file.name}.`);
        }
    }

    if (btn) {
    btn.innerHTML = originalHTML; // Возвращаем иконку "+"
    btn.disabled = false;
}
}

// === ЗАГРУЗКА ГАЛЕРЕИ С АВТОСИНХРОНИЗАЦИЕЙ ===
async function loadGallery() {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div class="loading">Загрузка</div>';

    try {
        const token = localStorage.getItem('github_token');
        const jsonUrl = `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`;

        // 1. Получаем JSON с GitHub (заголовок только если есть токен)
        const headers = {};
        if (token) headers['Authorization'] = `token ${token}`;
        
        const jsonRes = await fetch(jsonUrl, { headers });
        let currentPhotos = [];
        let sha = null;
        
        if (jsonRes.ok) {
            const data = await jsonRes.json();
            currentPhotos = JSON.parse(atob(data.content));
            sha = data.sha;
            console.log(`✅ JSON загружен: ${currentPhotos.length} фото`);
        } else {
            console.warn(`⚠️ Не удалось загрузить JSON: статус ${jsonRes.status}`);
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
            .filter(f => {
                // Фильтруем битые файлы с именем 'undefined'
                if (!f.Key || f.Key === 'undefined' || f.Key.includes('undefined')) {
                    console.warn(`🗑️ Пропускаем битый файл: ${f.Key}`);
                    return false;
                }
                return !jsonKeys.has(f.Key);
            })
            .map(f => {
                const key = f.Key;
                const title = key.split('/').pop().replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
                
                let date = null;
                let tagYear = null;
                const match = key.match(/(\d{4})(\d{2})(\d{2})/);
                if (match) {
                    const year = parseInt(match[1]);
                    if (year >= 1999 && year <= 2100) {
                        date = new Date(`${match[1]}-${match[2]}-${match[3]}`).getTime();
                        tagYear = year;
                    }
                }
                return { title, key, date, tagYear };
            });

        // 4. Автосинхронизация (только если есть токен)
        if (missingInJson.length > 0 && token) {
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

        // 5. Сохраняем глобально и рендерим
        window.galleryPhotos = currentPhotos;
        gallery.innerHTML = '';
        
        if (sortMode !== 'default') {
            renderSortedGallery(currentPhotos);
        } else {
            currentPhotos.forEach(photo => renderCard(photo, -1));
        }

        if (currentPhotos.length === 0) {
            gallery.innerHTML = '<div class="loading">Нет фото. Нажми + чтобы добавить.</div>';
        }

        // === ✅ ГАЛЕРЕЯ ЗАГРУЖЕНА — сигнализируем hero-section ===
        if (typeof galleryLoaded !== 'undefined') {
            galleryLoaded = true;
            if (typeof checkReady === 'function') {
                checkReady();
            }
        }

    } catch (err) {
        console.error('❌ Ошибка загрузки:', err);
        // Фоллбэк
        try {
            const token = localStorage.getItem('github_token');
            const headers = {};
            if (token) headers['Authorization'] = `token ${token}`;
            
            const fallbackRes = await fetch(
                `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`,
                { headers }
            );
            if (fallbackRes.ok) {
                const data = await fallbackRes.json();
                const photos = JSON.parse(atob(data.content));
                window.galleryPhotos = photos;
                gallery.innerHTML = '';
                photos.forEach(photo => renderCard(photo, -1));
                
                // === ✅ Фоллбэк тоже считается загрузкой ===
                if (typeof galleryLoaded !== 'undefined') {
                    galleryLoaded = true;
                    if (typeof checkReady === 'function') {
                        checkReady();
                    }
                }
            } else {
                gallery.innerHTML = '<div class="loading">Ошибка загрузки. Проверь интернет.</div>';
            }
        } catch {
            gallery.innerHTML = '<div class="loading">Ошибка. Попробуй позже.</div>';
        }
    }
}

// Рендер карточки (исправлено: явные имена параметров)
function renderCard(photo, index, isNoDate = false, target = null) {
    const card = document.createElement('div');
    card.className = 'photo-card' + (isNoDate ? ' no-date' : '');
    card.dataset.key = photo.key;

    const imgUrl = `${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${photo.key}`;

    const img = document.createElement('img');
    img.src = imgUrl;
    img.alt = photo.title;
    img.loading = 'lazy';
    img.style.cursor = 'pointer';
    img.onerror = () => { card.style.display = 'none'; };

    // Touch/Click для лайтбокса
    let touchStartX = 0, touchStartY = 0;
    img.addEventListener('touchstart', (e) => {
        touchStartX = e.touches[0].clientX; touchStartY = e.touches[0].clientY;
    }, { passive: true });
    img.addEventListener('touchend', (e) => {
        if (Math.abs(e.changedTouches[0].clientX - touchStartX) < 15 &&
            Math.abs(e.changedTouches[0].clientY - touchStartY) < 15) {
            e.preventDefault(); e.stopPropagation(); openLightbox(imgUrl);
        }
    }, { passive: false });
    img.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation(); openLightbox(imgUrl);
    });

    // === КНОПКИ (только админу) ===
    if (isAdmin) {
        const overlay = document.createElement('div');
        overlay.className = 'delete-overlay';
        
        const delBtn = document.createElement('button');
        delBtn.className = 'delete-btn';
        delBtn.title = 'Удалить';
        delBtn.innerHTML = '<img src="delete.png" alt="Удалить">';
        delBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            deletePhoto(photo.key, photo.title, card);
        });
        
        const editBtn = document.createElement('button');
        editBtn.className = 'edit-meta-btn';
        editBtn.title = 'Редактировать год';
        editBtn.innerHTML = '<img src="edit.png">';
        editBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            let currentVal = 'нет данных';
            if (photo.tagYear) currentVal = photo.tagYear;
            else if (photo.date && !isNaN(new Date(photo.date).getTime())) {
                currentVal = new Date(photo.date).getFullYear();
            }
            const newYear = prompt('Введите год для фотографии:', currentVal);
            if (newYear === null) return;
            const yearNum = parseInt(newYear);
            if (isNaN(yearNum) || yearNum < 1900 || yearNum > 2100) {
                alert('Нужна дата от 1999-?');
                return;
            }
            try {
                await syncJSON([{ key: photo.key, tagYear: yearNum }], 'updateTag');
                loadGallery();
            } catch (err) { alert('Ошибка сохранения'); }
        });
        
        overlay.appendChild(delBtn);
        overlay.appendChild(editBtn);
        card.appendChild(overlay);
    }
    
    card.appendChild(img);
    
    // Добавляем в целевой контейнер или в галерею
    const container = target || document.getElementById('gallery');
    if (container && container.appendChild) {
        container.appendChild(card);
    }
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

if (action === 'add') {
current.push(...changes);
    } else if (action === 'delete') {
        current = current.filter(p => p.key !== changes[0].key);
    } else if (action === 'updateTag') {
        const target = changes[0];
        const idx = current.findIndex(p => p.key === target.key);
        if (idx !== -1) {
            current[idx].tagYear = target.tagYear;
        }
    }
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
    const icon = sortMode === 'date' ? './timer.png' : './color.png';
    sortBtn.innerHTML = `<img src="${icon}" alt="Сортировка">`;
}

sortMode = 'date'; // Стартовый режим
updateSortIcon();

// Переключение режима
if (sortBtn) {
    sortBtn.addEventListener('click', () => {
        // Переключаем: date <-> color
        sortMode = sortMode === 'date' ? 'color' : 'date';
        localStorage.setItem('gallerySortMode', sortMode);
        updateSortIcon();
        
        // Сортируем УЖЕ ЗАГРУЖЕННЫЕ фото (работает у всех)
        if (window.galleryPhotos?.length > 0) {
            renderSortedGallery(window.galleryPhotos);
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

//СОРТИРОВКА
async function renderSortedGallery(photosSource) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div class="loading">Сортировка...</div>';
    await new Promise(r => setTimeout(r, 30));

    let photos = Array.isArray(photosSource) ? [...photosSource] : [];
    
    // === ФИЛЬТР: убираем фото с невалидными ключами (фантомные записи) ===
    const beforeFilter = photos.length;
    photos = photos.filter(p => {
        // Проверяем, что ключ существует, не пустой и не "undefined"
        if (!p.key || p.key === 'undefined' || p.key.trim() === '' || p.key === 'null') {
            console.warn(`🗑️ Исключено фото с битым ключом:`, p);
            return false;
        }
        return true;
    });
    if (beforeFilter !== photos.length) {
        console.log(`✅ Отфильтровано: ${beforeFilter} → ${photos.length} фото`);
    }
    
    if (photos.length === 0) {
        gallery.innerHTML = '<div class="loading">Нет фото</div>';
        return;
    }

    // === РЕЖИМ ЦВЕТА ===
    if (sortMode === 'color') {
        gallery.classList.remove('date-mode'); // Выключаем snap-scroll
        const withHue = await Promise.all(photos.map(async p => {
            const cacheKey = `hue_${p.key}`;
            let hue = localStorage.getItem(cacheKey);
            if (hue === null) {
                hue = await getPhotoHueSimple(`${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${p.key}`);
                localStorage.setItem(cacheKey, hue);
            }
            return { ...p, hue: parseInt(hue) };
        }));
        withHue.sort((a, b) => ((a.hue + 330) % 360) - ((b.hue + 330) % 360));
        gallery.innerHTML = '';
        withHue.forEach(p => {
            const y = p.tagYear;
            const valid = (y !== null && y !== undefined && typeof y === 'number' && y >= 1999 && y <= 2100);
            renderCard(p, -1, !valid, null); // ← СТАЛО: явно передаём null как target
        });
        return;
    }

 gallery.innerHTML = '';
    gallery.classList.add('date-mode'); // Включаем snap-scroll
    
    const groups = {};
    const unknown = [];

    photos.forEach(p => {
        const y = p.tagYear;
        
        // === ЖЁСТКАЯ ВАЛИДАЦИЯ: только число 1999-2100 ===
        let isValid = false;
        if (typeof y === 'number' && !isNaN(y) && y >= 1999 && y <= 2100) {
            isValid = true;
        }
        else if (typeof y === 'string') {
            const num = parseInt(y.trim(), 10);
            if (!isNaN(num) && num >= 1999 && num <= 2100) {
                isValid = true;
                p.tagYear = num;
            }
        }
        
        if (isValid) {
            const year = String(p.tagYear);
            if (!groups[year]) groups[year] = [];
            groups[year].push(p);
        } else {
            console.log(`⚠️ Фото без валидного тега: ${p.key?.substring(0,40)}..., tagYear:`, y);
            unknown.push(p);
        }
    });

    const sortedYears = Object.keys(groups).sort((a, b) => parseInt(b) - parseInt(a));

    // 1. Группы с валидными тегами (каждый год = отдельный блок)
    sortedYears.forEach(year => {
        // Создаём секцию года
        const section = document.createElement('div');
        section.className = 'year-section';
        
        // Заголовок
        const header = document.createElement('div');
        header.className = 'year-header';
        header.textContent = year;
        section.appendChild(header);
        
        // Мозаика
        const grid = document.createElement('div');
        grid.className = 'mosaic-grid';
        
        groups[year].forEach(photo => renderCard(photo, -1, false, grid));
        
        section.appendChild(grid);
        gallery.appendChild(section);
    });

    // 2. Группа "-" (если есть)
    if (unknown.length > 0) {
        console.log(`📁 Показываю "-" (${unknown.length} фото без тега)`);
        
        const section = document.createElement('div');
        section.className = 'year-section';
        
        const header = document.createElement('div');
        header.className = 'year-header';
        header.textContent = '-';
        section.appendChild(header);
        
        const grid = document.createElement('div');
        grid.className = 'mosaic-grid';
        unknown.forEach(photo => renderCard(photo, -1, true, grid));
        
        section.appendChild(grid);
        gallery.appendChild(section);
    } else {
        console.log(`✅ Все ${photos.length} фото имеют валидные теги, "-" не показываю`);
    }
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


// === ЗАГЛАВНЫЙ БЛОК С ПРОГРЕСС БАРОМ ===
const heroSection = document.getElementById('hero-section');
const progressBar = document.getElementById('heroProgressBar');
let heroVisible = true;
let isAnimating = false;
let isReady = false;
let galleryLoaded = false;
let progressValue = 0;

// Проверяем, был ли уже скрыт герой в этой сессии
let heroDismissed = sessionStorage.getItem('heroDismissed') === 'true';

// Если уже скрыт — сразу убираем
if (heroDismissed && heroSection) {
    heroSection.style.display = 'none';
    heroVisible = false;
    document.body.classList.add('hero-hidden');
}

// Анимация прогресс бара
function animateProgress() {
    if (progressValue < 100) {
        progressValue += 2;
        if (progressBar) {
            progressBar.style.width = progressValue + '%';
        }
        setTimeout(animateProgress, 50);
    } else {
        checkReady();
    }
}

// Проверяем готовность
function checkReady() {
    if (galleryLoaded && progressValue >= 100 && !heroDismissed) {
        isReady = true;
        if (heroSection) {
            heroSection.classList.add('ready');
        }
        console.log('✅ Hero ready! Scroll up to enter');
    }
}

// Запускаем прогресс при загрузке
window.addEventListener('load', () => {
    if (!heroDismissed) {
        setTimeout(animateProgress, 500);
    }
});

// Wheel event для десктопа
window.addEventListener('wheel', (e) => {
    if (isAnimating || heroDismissed) return;
    
    // Скролл вверх (скрываем героя)
    if (e.deltaY < -50 && heroVisible) {
        e.preventDefault();
        isAnimating = true;
        heroVisible = false;
        heroDismissed = true;
        
        // Сохраняем в сессии
        sessionStorage.setItem('heroDismissed', 'true');
        
        heroSection.classList.add('hidden');
        document.body.classList.add('hero-hidden');
        
        setTimeout(() => {
            isAnimating = false;
            heroSection.style.display = 'none';
        }, 600);
    }
    // Скролл вниз — НЕ возвращаем героя, если он уже был скрыт
}, { passive: false });

// Touch события для мобильных
let touchStartY = 0;

window.addEventListener('touchstart', (e) => {
    touchStartY = e.touches[0].clientY;
}, { passive: true });

window.addEventListener('touchend', (e) => {
    if (isAnimating || heroDismissed) return;
    
    const touchEndY = e.changedTouches[0].clientY;
    const diff = touchStartY - touchEndY;
    
    // Свайп вверх (скрываем)
    if (diff < -100 && heroVisible) {
        isAnimating = true;
        heroVisible = false;
        heroDismissed = true;
        
        sessionStorage.setItem('heroDismissed', 'true');
        
        heroSection.classList.add('hidden');
        document.body.classList.add('hero-hidden');
        heroSection.style.display = 'none';
        
        setTimeout(() => {
            isAnimating = false;
        }, 600);
    }
    // Свайп вниз — НЕ возвращаем, если уже скрыт
}, { passive: false });

// Инициализация
if (heroSection && !heroDismissed) {
    document.body.style.overflow = 'hidden';
}


// Старт
loadGallery();

// Когда галерея загрузилась
window.addEventListener('load', () => {
    // Ждём пока загрузится галерея
    setTimeout(() => {
        const gallery = document.getElementById('gallery');
        if (gallery && gallery.children.length > 0) {
            // Галерея загружена, hero всё ещё виден
            console.log('✅ Hero section ready, scroll up to hide');
        }
    }, 1000);
});