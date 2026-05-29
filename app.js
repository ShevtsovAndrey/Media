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

// === УПРАВЛЕНИЕ СТАТУСОМ ===
function setHeroStatus(status) {
    const statusEl = document.getElementById('heroStatus');
    const textEl = document.getElementById('statusText');
    const loader = document.getElementById('heroLoader');
    const arrow = document.getElementById('heroArrow');
    if (!statusEl || !textEl) return;
    
    switch(status) {
        case 'loading':
            textEl.textContent = 'Загрузка';
            statusEl.style.display = 'flex';
            if (loader) loader.style.display = 'flex';
            if (arrow) arrow.classList.remove('show');
            break;
        case 'sorting':
            textEl.textContent = 'Анализ и сортировка';
            statusEl.style.display = 'flex';
            if (loader) loader.style.display = 'flex';
            if (arrow) arrow.classList.remove('show');
            break;
        case 'ready':
            statusEl.style.display = 'none';
            if (loader) loader.style.display = 'none';
            if (arrow) arrow.classList.add('show');
            break;
    }
}

// === AWS SDK ===
AWS.config.update({
    accessKeyId: YANDEX_CONFIG.accessKeyId,
    secretAccessKey: YANDEX_CONFIG.secretAccessKey,
    region: YANDEX_CONFIG.region,
    endpoint: YANDEX_CONFIG.endpoint,
    s3ForcePathStyle: true
});
const s3 = new AWS.S3();
window.galleryPhotos = [];

// === EXIF ===
function getExifDate(file) {
    return new Promise(resolve => {
        if (!file.type.includes('jpeg') && !file.type.includes('jpg')) {
            return resolve(file.lastModified);
        }
        EXIF.getData(file, function() {
            const dateTaken = EXIF.getTag(this, 'DateTimeOriginal') || EXIF.getTag(this, 'CreateDate');
            if (dateTaken) {
                const clean = dateTaken.replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3');
                resolve(new Date(clean).getTime());
            } else resolve(file.lastModified);
        });
    });
}

// === СИНХРОНИЗАЦИЯ ===
let jsonSyncQueue = Promise.resolve();
function queueSyncJSON(changes, action) {
    jsonSyncQueue = jsonSyncQueue.then(() => syncJSON(changes, action)).catch(err => {
        console.error("❌ Ошибка синхронизации:", err);
        alert("Не удалось обновить список фото.");
    });
    return jsonSyncQueue;
}

const isAdmin = !!localStorage.getItem('github_token');
if (isAdmin) document.getElementById('addBtn').style.display = 'flex';

// === ЗАГРУЗКА ФАЙЛОВ ===
async function uploadFiles(files) {
    if (!files?.length) return;
    const btn = document.getElementById('addBtn');
    if (btn) { btn.innerHTML = '<img src="loader.png" class="loading-icon">'; btn.disabled = true; }
    
    for (const file of files) {
        try {
            const key = `${Date.now()}_${file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')}`;
            const title = file.name.split('.')[0];
            const photoDate = await getExifDate(file);
            localStorage.setItem(`exif_date_${key}`, photoDate);
            
            await new Promise((res, rej) => {
                s3.upload({ Bucket: YANDEX_CONFIG.bucket, Key: key, Body: file, ContentType: file.type }, (e, d) => e ? rej(e) : res(d));
            });
            
            const year = photoDate ? new Date(photoDate).getFullYear() : null;
            await syncJSON([{ title, key, date: photoDate, tagYear: year }], 'add');
            
            const newPhoto = { title, key, date: photoDate, tagYear: year };
            if (Array.isArray(window.galleryPhotos)) window.galleryPhotos.push(newPhoto);
            
            renderSortedGallery(window.galleryPhotos);
            
        } catch (err) {
            console.error(`❌ Ошибка ${file.name}:`, err);
            alert(`Не удалось сохранить ${file.name}.`);
        }
    }
    if (btn) { btn.innerHTML = '+'; btn.disabled = false; }
}

// === ЗАГРУЗКА ГАЛЕРЕИ ===
async function loadGallery() {
    const gallery = document.getElementById('gallery');
    setHeroStatus('loading');
    gallery.innerHTML = '';
    
    try {
        let githubPhotos = [];
        try {
            const jsonUrl = `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`;
            const jsonRes = await fetch(jsonUrl);
            if (jsonRes.ok) {
                const data = await jsonRes.json();
                githubPhotos = JSON.parse(atob(data.content));
            }
        } catch (e) { console.warn('⚠️ JSON не загружен'); }
        
        const s3Files = await new Promise((res, rej) => {
            s3.listObjectsV2({ Bucket: YANDEX_CONFIG.bucket }, (e, d) => e ? rej(e) : res(d.Contents || []));
        });
        
        const githubMap = new Map();
        githubPhotos.forEach(p => { if (p.key) githubMap.set(p.key, p); });
        
        const galleryPhotos = s3Files
            .filter(f => {
                const k = f.Key;
                if (!k || k === 'undefined' || k.includes('logo') || k.includes('.txt') || k.includes('.json')) return false;
                return /\.(jpg|jpeg|png|gif|webp|heic)$/i.test(k);
            })
            .map(f => {
                const key = f.Key;
                const title = key.split('/').pop().replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
                const gh = githubMap.get(key) || {};
                let tagYear = null;
                const yt = gh.tagYear;
                if (typeof yt === 'number' && !isNaN(yt) && yt >= 1999 && yt <= 2100) tagYear = yt;
                return { title, key, date: gh.date || null, tagYear };
            });
        
        window.galleryPhotos = galleryPhotos;
        setHeroStatus('sorting');
        await renderSortedGallery(galleryPhotos);
        markEverythingReady();
    } catch (err) {
        console.error('❌ Ошибка загрузки:', err);
        markEverythingReady();
    }
}

// === РЕНДЕР КАРТОЧКИ ===
function renderCard(photo, index, isNoDate = false, target = null) {
    const card = document.createElement('div');
    card.className = 'photo-card' + (isNoDate ? ' no-date' : '');
    card.dataset.key = photo.key;
    const imgUrl = `${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${photo.key}`;
    
    const img = document.createElement('img');
    img.src = imgUrl; img.alt = photo.title; img.loading = 'lazy'; img.style.cursor = 'pointer';
    img.onerror = () => card.style.display = 'none';
    
    const openLightboxHandler = (e) => {
        if (card.classList.contains('show-menu')) return;
        e.preventDefault(); e.stopPropagation();
        openLightbox(imgUrl);
    };
    img.addEventListener('click', openLightboxHandler);
    
    // Touch для мобильных
    let tX = 0, tY = 0, tTimer = null;
    img.addEventListener('touchstart', e => { tX = e.touches[0].clientX; tY = e.touches[0].clientY; tTimer = setTimeout(() => {
        e.preventDefault(); e.stopPropagation();
        document.querySelectorAll('.photo-card.show-menu').forEach(c => c.classList.remove('show-menu'));
        card.classList.add('show-menu');
        if (navigator.vibrate) navigator.vibrate(50);
    }, 500); }, { passive: true });
    
    img.addEventListener('touchend', e => {
        if (tTimer) clearTimeout(tTimer); tTimer = null;
        if (card.classList.contains('show-menu')) return;
        if (Math.abs(e.changedTouches[0].clientX - tX) < 15 && Math.abs(e.changedTouches[0].clientY - tY) < 15) openLightboxHandler(e);
    }, { passive: true });
    
    img.addEventListener('touchmove', () => { if (tTimer) clearTimeout(tTimer); tTimer = null; }, { passive: true });
    
    // Кнопки админа
    if (isAdmin) {
        const overlay = document.createElement('div'); overlay.className = 'delete-overlay';
        overlay.addEventListener('click', e => { if (e.target === overlay && card.classList.contains('show-menu')) card.classList.remove('show-menu'); });
        
        const delBtn = document.createElement('button'); delBtn.className = 'delete-btn'; delBtn.title = 'Удалить';
        delBtn.innerHTML = '<img src="icons/delete.png" alt="Удалить">';
        delBtn.addEventListener('click', e => { e.stopPropagation(); card.classList.remove('show-menu'); deletePhoto(photo.key, photo.title, card); });
        
        const editBtn = document.createElement('button'); editBtn.className = 'edit-meta-btn'; editBtn.title = 'Редактировать год';
        editBtn.innerHTML = '<img src="icons/edit.png">';
        editBtn.addEventListener('click', async e => {
            e.stopPropagation();
            let val = photo.tagYear || (photo.date ? new Date(photo.date).getFullYear() : 'нет данных');
            const ny = prompt('Введите год:', val);
            if (ny === null) { card.classList.remove('show-menu'); return; }
            const yn = parseInt(ny);
            if (isNaN(yn) || yn < 1900 || yn > 2100) { alert('Год 1999-?'); card.classList.remove('show-menu'); return; }
            try { await syncJSON([{ key: photo.key, tagYear: yn }], 'updateTag'); card.classList.remove('show-menu'); loadGallery(); }
            catch (err) { alert('Ошибка'); card.classList.remove('show-menu'); }
        });
        
        overlay.appendChild(delBtn); overlay.appendChild(editBtn); card.appendChild(overlay);
    }
    
    card.appendChild(img);
    (target || document.getElementById('gallery')).appendChild(card);
}

// === УДАЛЕНИЕ ===
async function deletePhoto(key, title, cardEl) {
    if (!confirm(`Удалить "${title}"?`)) return;
    cardEl.style.opacity = '0.3'; cardEl.style.pointerEvents = 'none';
    try {
        await new Promise((res, rej) => s3.deleteObject({ Bucket: YANDEX_CONFIG.bucket, Key: key }, (e, d) => e ? rej(e) : res(d)));
        await queueSyncJSON([{ key }], 'delete');
        cardEl.remove();
    } catch (err) {
        console.error('❌ Ошибка удаления:', err);
        alert(`Не удалось удалить: ${err.message}`);
        cardEl.style.opacity = '1'; cardEl.style.pointerEvents = 'auto';
    }
}

// === СИНХРОНИЗАЦИЯ С GITHUB ===
async function syncJSON(changes, action, retries = 2) {
    const token = localStorage.getItem('github_token');
    const url = `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}`;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
    if (!getRes.ok) throw new Error('Не удалось получить gallery.json');
    const data = await getRes.json();
    let current = []; try { current = JSON.parse(atob(data.content)); } catch(e) { current = []; }
    const sha = data.sha;
    
    if (action === 'add') current.push(...changes);
    else if (action === 'delete') current = current.filter(p => p.key !== changes[0].key);
    else if (action === 'updateTag') { const i = current.findIndex(p => p.key === changes[0].key); if (i !== -1) current[i].tagYear = changes[0].tagYear; }
    
    const putRes = await fetch(url, {
        method: 'PUT', headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: action === 'add' ? 'Add' : 'Delete', content: btoa(JSON.stringify(current, null, 2)), branch: GITHUB_CONFIG.branch, sha })
    });
    if (!putRes.ok) {
        const err = await putRes.json().catch(() => ({}));
        if (putRes.status === 422 && retries > 0) { await new Promise(r => setTimeout(r, 1000)); return syncJSON(changes, action, retries - 1); }
        throw new Error(err.message || `GitHub API error ${putRes.status}`);
    }
}

// === ЛАЙТБОКС ===
function openLightbox(imgUrl) {
    let lb = document.getElementById('lightbox');
    if (lb) {
        const img = lb.querySelector('img');
        img.style.opacity = '0';
        setTimeout(() => { img.src = imgUrl; img.onload = () => img.style.opacity = '1'; }, 200);
        lb.classList.add('active');
        return;
    }
    lb = document.createElement('div'); lb.id = 'lightbox'; lb.className = 'lightbox'; lb.innerHTML = '<img src="" alt="">';
    document.body.appendChild(lb);
    const close = () => { lb.classList.remove('active'); setTimeout(() => lb.remove(), 200); };
    lb.addEventListener('click', close);
    document.addEventListener('keydown', function onEsc(e) {
        if (e.key === 'Escape' && document.getElementById('lightbox')) { close(); document.removeEventListener('keydown', onEsc); }
    });
    const img = lb.querySelector('img'); img.src = imgUrl;
    requestAnimationFrame(() => {
        if (img.complete) { img.style.opacity = '1'; lb.classList.add('active'); }
        else { img.onload = () => { img.style.opacity = '1'; lb.classList.add('active'); }; }
    });
}
window.openLightbox = openLightbox;

// === АНАЛИЗ ФОТО (HSL) ===
function analyzePhoto(imgUrl) {
    return new Promise(resolve => {
        const img = new Image(); img.crossOrigin = "Anonymous";
        img.onload = () => {
            const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d');
            canvas.width = 100; canvas.height = 100; ctx.drawImage(img, 0, 0, 100, 100);
            const imageData = ctx.getImageData(0, 0, 100, 100); const data = imageData.data;
            let totalR = 0, totalG = 0, totalB = 0, totalL = 0, totalS = 0, brightnessSum = 0;
            let darkPixels = 0, lightPixels = 0; const colorBins = new Array(12).fill(0); const pixels = [];
            
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i], g = data[i+1], b = data[i+2];
                const brightness = (r + g + b) / 3; brightnessSum += brightness;
                if (brightness < 50) darkPixels++; if (brightness > 200) lightPixels++;
                const hsl = rgbToHSL(r, g, b); totalL += hsl.l; totalS += hsl.s;
                colorBins[Math.floor(hsl.h / 30)]++; pixels.push(brightness);
            }
            const pixelCount = data.length / 4;
            const avgLightness = totalL / pixelCount, avgSaturation = totalS / pixelCount;
            const darkRatio = darkPixels / pixelCount, lightRatio = lightPixels / pixelCount;
            const dominantBin = colorBins.indexOf(Math.max(...colorBins)); const dominantHue = dominantBin * 30 + 15;
            const filledBins = colorBins.filter(c => c > pixelCount * 0.05).length; const colorDiversity = filledBins / 12;
            const meanBrightness = brightnessSum / pixelCount; let variance = 0;
            for (const p of pixels) variance += Math.pow(p - meanBrightness, 2);
            const stdDev = Math.sqrt(variance / pixelCount); const complexity = stdDev / 128;
            const simplicityScore = (1 - colorDiversity) * 0.3 + (1 - avgSaturation / 100) * 0.25 + (1 - complexity) * 0.2 + lightRatio * 0.15 + (1 - darkRatio) * 0.1;
            
            resolve({ hue: dominantHue, lightness: avgLightness, saturation: avgSaturation, colorDiversity, complexity, darkRatio, lightRatio, simplicityScore, debug: { filledBins, stdDev: Math.round(stdDev) } });
        };
        img.onerror = () => resolve({ hue: 0, lightness: 50, saturation: 50, colorDiversity: 0.5, complexity: 0.5, darkRatio: 0.5, lightRatio: 0.5, simplicityScore: 0.5, debug: { filledBins: 0, stdDev: 0 } });
        img.src = imgUrl;
    });
}

// === RGB → HSL ===
function rgbToHSL(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
    const l = (max + min) / 2; let h = 0, s = 0;
    if (delta !== 0) {
        s = l < 0.5 ? delta / (max + min) : delta / (2 - max - min);
        if (max === r) h = ((g - b) / delta + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / delta + 2) / 6;
        else h = ((r - g) / delta + 4) / 6;
    }
    return { h: Math.round(h * 360), s: Math.round(s * 100), l: Math.round(l * 100) };
}


// === ВИЗУАЛЬНЫЙ СКОР: Яркость 50 + Теплота 20 + Насыщенность 15 + Оттенок 15 ===
function computeVisualScore(hue, saturation, lightness) {
    // 1. ЯРКОСТЬ (50%): светлые/белые → тёмные/чёрные
    const lightnessScore = ((100 - lightness) / 100) * 50;
    
    // 2. ТЕПЛОТА (20%): холодные (синие ~240°) → тёплые (оранжевые/красные)
    const distanceFromBlue = Math.min(
        Math.abs(hue - 240), 
        360 - Math.abs(hue - 240)
    );
    const warmth = distanceFromBlue / 120; // 0.0 (холодный) → 1.0 (тёплый)
    const warmthScore = warmth * 20;
    
    // 3. НАСЫЩЕННОСТЬ (15%): блёклые/серые → сочные/насыщенные
    const saturationScore = (saturation / 100) * 15;
    
    // 4. ОТТЕНОК (15%): плавное распределение по спектру (0° → 360°)
    const hueScore = (hue / 360) * 15;
    
    return lightnessScore + warmthScore + saturationScore + hueScore; // Максимум 100
}

// === СОРТИРОВКА + РЕНДЕРИНГ + MASONRY ===
async function renderSortedGallery(photosSource) {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '';
    await new Promise(r => setTimeout(r, 30));
    
    let photos = Array.isArray(photosSource) ? [...photosSource] : [];
    photos = photos.filter(p => p.key && p.key !== 'undefined' && p.key.trim() !== '' && p.key !== 'null');
    if (photos.length === 0) { gallery.innerHTML = '<div class="loading">Нет фото</div>'; return; }
    
    console.log('🎨 Анализирую', photos.length, 'фото...');
    const photosWithAnalysis = await Promise.all(photos.map(async p => {
        const analysis = await analyzePhoto(`${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${p.key}`);
        return { ...p, analysis };
    }));
    
    // Группировка по годам
    const groups = {}, unknown = [];
    photosWithAnalysis.forEach(p => {
        const y = p.tagYear; let isValid = false;
        if (typeof y === 'number' && !isNaN(y) && y >= 1999 && y <= 2100) isValid = true;
        else if (typeof y === 'string') { const num = parseInt(y.trim(), 10); if (!isNaN(num) && num >= 1999 && num <= 2100) { isValid = true; p.tagYear = num; } }
        if (isValid) { const year = String(p.tagYear); if (!groups[year]) groups[year] = []; groups[year].push(p); }
        else unknown.push(p);
    });
    
    // === НОВАЯ СОРТИРОВКА: по визуальному скору (светлые/насыщенные → тёмные/блёклые) ===
    Object.keys(groups).forEach(year => {
        groups[year].sort((a, b) => {
            const scoreA = computeVisualScore(a.analysis.hue, a.analysis.saturation, a.analysis.lightness);
            const scoreB = computeVisualScore(b.analysis.hue, b.analysis.saturation, b.analysis.lightness);
            return scoreA - scoreB; // По возрастанию: 0 (светлое/насыщенное) → 100 (тёмное/блёклое)
        });
    });
    
    // Рендеринг
    gallery.classList.add('date-mode');
    const sortedYears = Object.keys(groups).sort((a, b) => parseInt(b) - parseInt(a));
    
    sortedYears.forEach(year => {
        const section = document.createElement('div'); section.className = 'year-section';
        const header = document.createElement('div'); header.className = 'year-header'; header.textContent = year;
        section.appendChild(header);
        const grid = document.createElement('div'); grid.className = 'mosaic-grid';
        groups[year].forEach(photo => renderCard(photo, -1, false, grid));
        section.appendChild(grid); gallery.appendChild(section);
    });
    
    if (unknown.length > 0) {
        const section = document.createElement('div'); section.className = 'year-section';
        const header = document.createElement('div'); header.className = 'year-header'; header.textContent = '-';
        section.appendChild(header);
        const grid = document.createElement('div'); grid.className = 'mosaic-grid';
        unknown.forEach(photo => renderCard(photo, -1, true, grid));
        section.appendChild(grid); gallery.appendChild(section);
    }
    
    console.log('✅ Сортировка завершена');
    
    // === ИНИЦИАЛИЗАЦИЯ MASONRY (ПЛОТНАЯ УПАКОВКА) ===
    const grids = document.querySelectorAll('.mosaic-grid');
    grids.forEach(grid => {
        // Уничтожаем старый инстанс, если есть
        if (grid.masonry) grid.masonry.destroy();
        
        // Создаём новый
        grid.masonry = new Masonry(grid, {
            itemSelector: '.photo-card',
            columnWidth: '.photo-card',
            percentPosition: true,
            horizontalOrder: true, // ← СОХРАНЯЕТ ПОРЯДОК СОРТИРОВКИ (слева-направо)
            transitionDuration: 0,
            stagger: 0
        });
    });
}

// === ПЕРЕСЧЁТ MASONRY ПРИ ИЗМЕНЕНИИ РАЗМЕРА ОКНА ===
window.addEventListener('resize', () => {
    document.querySelectorAll('.mosaic-grid').forEach(grid => {
        if (grid.masonry) grid.masonry.layout();
    });
});

// === DRAG & DROP ===
window.addEventListener('load', () => {
    const dragOverlay = document.getElementById('dragOverlay');
    if (!dragOverlay) { console.error('❌ #dragOverlay не найден'); return; }
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        document.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); }, false);
    });
    document.addEventListener('dragenter', () => dragOverlay.classList.add('active'), false);
    document.addEventListener('dragleave', e => { if (e.clientX === 0 && e.clientY === 0) dragOverlay.classList.remove('active'); }, false);
    document.addEventListener('drop', async e => {
        dragOverlay.classList.remove('active');
        const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
        if (files.length === 0) return;
        if (typeof uploadFiles === 'function') await uploadFiles(files);
    }, false);
});

// === HERO DRAG ===
let heroSection, isDragging = false, startY = 0, currentY = 0, heroDismissed = false, isEverythingReady = false;
document.addEventListener('DOMContentLoaded', () => {
    heroSection = document.getElementById('hero-section');
    if (heroSection) {
        document.body.style.overflow = 'hidden';
        heroSection.addEventListener('mousedown', e => { if (heroDismissed || !isEverythingReady) return; isDragging = true; startY = e.clientY; heroSection.classList.add('dragging'); });
        window.addEventListener('mousemove', e => { if (!isDragging || heroDismissed || !isEverythingReady) return; currentY = e.clientY; if (currentY - startY < 0) heroSection.style.transform = `translateY(${currentY - startY}px)`; });
        window.addEventListener('mouseup', () => { if (!isDragging || heroDismissed || !isEverythingReady) return; isDragging = false; heroSection.classList.remove('dragging'); if (currentY - startY < -window.innerHeight * 0.4) dismissHero(); else heroSection.style.transform = 'translateY(0)'; currentY = 0; startY = 0; });
        heroSection.addEventListener('touchstart', e => { if (heroDismissed || !isEverythingReady) return; isDragging = true; startY = e.touches[0].clientY; heroSection.classList.add('dragging'); }, { passive: true });
        window.addEventListener('touchmove', e => { if (!isDragging || heroDismissed || !isEverythingReady) return; currentY = e.touches[0].clientY; if (currentY - startY < 0) heroSection.style.transform = `translateY(${currentY - startY}px)`; }, { passive: true });
        window.addEventListener('touchend', () => { if (!isDragging || heroDismissed || !isEverythingReady) return; isDragging = false; heroSection.classList.remove('dragging'); if (currentY - startY < -window.innerHeight * 0.4) dismissHero(); else heroSection.style.transform = 'translateY(0)'; currentY = 0; startY = 0; }, { passive: true });
    }
});
function dismissHero() { if (!heroSection || heroDismissed) return; heroDismissed = true; heroSection.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)'; heroSection.style.transform = 'translateY(-100%)'; setTimeout(() => { heroSection.classList.add('hidden'); heroSection.style.display = 'none'; document.body.style.overflow = ''; }, 400); }
function markEverythingReady() {
    isEverythingReady = true;
    setHeroStatus('ready');
    if (heroSection) heroSection.classList.add('ready');
}

// === ТЕМА ИЗ КОНСОЛИ ===
window.setTheme = function(mode) {
    const body = document.body;
    if (mode === 'light' || mode === 'dark' || mode === 'auto') {
        body.setAttribute('data-theme', mode === 'auto' ? '' : mode);
        localStorage.setItem('theme-force', mode);
    }
};
document.addEventListener('DOMContentLoaded', () => { const saved = localStorage.getItem('theme-force'); if (saved) window.setTheme(saved); });

// === СКРОЛЛ ГАЛЕРЕИ ===
const galleryEl = document.getElementById('gallery');
let isGalleryDrag = false, dragStartY = 0, dragScrollStart = 0, dragMoved = false, wheelSnapTimeout = null;
function enableSnap() { if (galleryEl.classList.contains('date-mode')) galleryEl.style.scrollSnapType = 'y mandatory'; }
galleryEl.addEventListener('mousedown', e => {
    if (e.target.closest('.delete-btn, .edit-meta-btn, .lightbox, .add-btn')) return;
    if (!galleryEl.classList.contains('date-mode')) return;
    isGalleryDrag = true; dragMoved = false; dragStartY = e.pageY; dragScrollStart = galleryEl.scrollTop; galleryEl.style.cursor = 'grabbing';
});
window.addEventListener('mousemove', e => {
    if (!isGalleryDrag) return;
    if (Math.abs(e.pageY - dragStartY) > 10) dragMoved = true;
    if (dragMoved) { e.preventDefault(); galleryEl.scrollTop = dragScrollStart - (e.pageY - dragStartY); }
});
window.addEventListener('mouseup', () => { if (!isGalleryDrag) return; isGalleryDrag = false; galleryEl.style.cursor = ''; });
galleryEl.addEventListener('click', e => { if (dragMoved) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); dragMoved = false; } }, true);
galleryEl.addEventListener('mouseleave', () => { if (isGalleryDrag) { isGalleryDrag = false; dragMoved = false; galleryEl.style.cursor = ''; } });
galleryEl.addEventListener('wheel', e => {
    if (isGalleryDrag) return;
    if (galleryEl.style.scrollSnapType !== 'y mandatory') enableSnap();
    clearTimeout(wheelSnapTimeout); wheelSnapTimeout = setTimeout(enableSnap, 150);
}, { passive: true });

// === СТАРТ ===
loadGallery();