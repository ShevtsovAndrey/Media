// === БЕЗОПАСНОЕ ПОЛУЧЕНИЕ AWS SDK ===
// UMD-сборка может положить классы в window или window.AWS
const sdk = window.AWS || window["@aws-sdk/client-s3"] || {};
const S3Client = sdk.S3Client || (typeof window.S3Client !== 'undefined' ? window.S3Client : null);
const PutObjectCommand = sdk.PutObjectCommand || (typeof window.PutObjectCommand !== 'undefined' ? window.PutObjectCommand : null);
const DeleteObjectCommand = sdk.DeleteObjectCommand || (typeof window.DeleteObjectCommand !== 'undefined' ? window.DeleteObjectCommand : null);

if (!S3Client) {
    console.error('AWS SDK не загружен. Проверь консоль и интернет.');
    alert('Ошибка инициализации SDK. Проверь F12 → Console.');
}

// === НАСТРОЙКИ (вставь свои данные) ===
const YANDEX_CONFIG = {
    region: 'ru-central1',
    endpoint: 'https://storage.yandexcloud.net',
    bucket: 'my-gallery-photos-777',      // ← ТВОЙ БАКЕТ
    accessKeyId: 'YCAJEdsduslR2tqI4X7bloeTg',    // ← ТВОЙ ACCESS KEY
    secretAccessKey: 'YCNSa7x9zzWqAGzAI8Iyvv6j3475TIpIy7PGqEs5' // ← ТВОЙ SECRET KEY
};

const GITHUB_CONFIG = {
    repo: 'ShevtsovAndrey/Media',
    branch: 'main',
    jsonPath: 'data/gallery.json'
};

// Инициализация клиента
const s3 = new S3Client({
    region: YANDEX_CONFIG.region,
    endpoint: YANDEX_CONFIG.endpoint,
    credentials: {
        accessKeyId: YANDEX_CONFIG.accessKeyId,
        secretAccessKey: YANDEX_CONFIG.secretAccessKey
    },
    forcePathStyle: true // Обязательно для Яндекса
});

// Проверка админа
const isAdmin = !!localStorage.getItem('github_token');
if (isAdmin) document.getElementById('addBtn').style.display = 'flex';

// Загрузка галереи
async function loadGallery() {
    const gallery = document.getElementById('gallery');
    gallery.innerHTML = '<div class="loading">Загрузка...</div>';

    try {
        const res = await fetch(`https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}?ref=${GITHUB_CONFIG.branch}`);
        let photos = [];
        if (res.ok) {
            const data = await res.json();
            photos = JSON.parse(atob(data.content));
        }
        gallery.innerHTML = '';
        photos.forEach((photo, i) => renderCard(photo, i));
    } catch (err) {
        console.error(err);
        gallery.innerHTML = '<div class="loading">Ошибка загрузки</div>';
    }
}

// Рендер карточки
function renderCard(photo, index) {
    const card = document.createElement('div');
    card.className = 'photo-card';
    card.dataset.index = index;

    const imgUrl = `${YANDEX_CONFIG.endpoint}/${YANDEX_CONFIG.bucket}/${photo.key}`;

    card.innerHTML = `
        <img src="${imgUrl}" alt="${photo.title}" loading="lazy" onerror="this.style.display='none'">
        ${isAdmin ? `<div class="delete-overlay"><button class="delete-btn" title="Удалить">&minus;</button></div>` : ''}
    `;

    if (isAdmin) {
        card.querySelector('.delete-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            deletePhoto(photo.key, photo.title, index);
        });
    }
    document.getElementById('gallery').appendChild(card);
}

// Кнопка "+"
document.getElementById('addBtn').addEventListener('click', () => {
    document.getElementById('fileInput').click();
});

// Загрузка файлов
document.getElementById('fileInput').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    if (!files.length) return;

    const btn = document.getElementById('addBtn');
    btn.textContent = '⏳';
    btn.disabled = true;

    for (const file of files) {
        try {
            const key = `${Date.now()}_${file.name.replace(/\s+/g, '_').replace(/[^a-zA-Z0-9._-]/g, '')}`;
            
            await s3.send(new PutObjectCommand({
                Bucket: YANDEX_CONFIG.bucket,
                Key: key,
                Body: file,
                ContentType: file.type
            }));

            await syncJSON([{ title: file.name.split('.')[0], key }], 'add');
            renderCard({ title: file.name.split('.')[0], key }, -1);
        } catch (err) {
            console.error(err);
            alert(`Ошибка ${file.name}: ${err.message}`);
        }
    }

    btn.textContent = '+';
    btn.disabled = false;
    e.target.value = '';
});

// Удаление фото
async function deletePhoto(key, title, index) {
    if (!confirm(`Удалить "${title}"?`)) return;

    const cards = document.querySelectorAll('.photo-card');
    cards[index].style.opacity = '0.3';
    cards[index].style.pointerEvents = 'none';

    try {
        await s3.send(new DeleteObjectCommand({
            Bucket: YANDEX_CONFIG.bucket,
            Key: key
        }));
        await syncJSON([{ key }], 'delete');
        cards[index].remove();
    } catch (err) {
        console.error(err);
        alert('Ошибка удаления: ' + err.message);
        cards[index].style.opacity = '1';
        cards[index].style.pointerEvents = 'auto';
    }
}

// Синхронизация с GitHub JSON
async function syncJSON(changes, action) {
    const token = localStorage.getItem('github_token');
    const url = `https://api.github.com/repos/${GITHUB_CONFIG.repo}/contents/${GITHUB_CONFIG.jsonPath}`;

    const getRes = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
    let current = [], sha = null;

    if (getRes.ok) {
        const data = await getRes.json();
        try { current = JSON.parse(atob(data.content)); } catch(e) { current = []; }
        sha = data.sha;
    }

    if (action === 'add') current.push(...changes);
    else current = current.filter(p => p.key !== changes[0].key);

    await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            message: action === 'add' ? 'Add photo' : 'Delete photo',
            content: btoa(JSON.stringify(current, null, 2)),
            branch: GITHUB_CONFIG.branch,
            sha
        })
    });
}

// Старт
loadGallery();