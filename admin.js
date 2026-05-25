const REPO = 'ShevtsovAndrey/Media';
const BRANCH = 'main';
let pendingFile = null;

// 1. Проверка токена при загрузке главной страницы
window.addEventListener('DOMContentLoaded', () => {
    const token = localStorage.getItem('github_token');
    if (token) {
        document.getElementById('addBtn').style.display = 'flex';
    }
});

// 2. Нажатие на "+" → сразу открываем выбор файла
document.getElementById('addBtn').addEventListener('click', () => {
    document.getElementById('systemFileInput').click();
});

// 3. Файл выбран → открываем модалку для ввода данных
document.getElementById('systemFileInput').addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        pendingFile = e.target.files[0];
        document.getElementById('infoModal').style.display = 'flex';
        document.getElementById('uploadStatus').textContent = '';
    }
});

// 4. Процесс загрузки
async function startUpload() {
    const token = localStorage.getItem('github_token');
    const title = document.getElementById('photoTitle').value.trim() || pendingFile.name;
    const location = document.getElementById('photoLocation').value.trim() || 'Без локации';
    const status = document.getElementById('uploadStatus');
    const btn = document.querySelector('#infoModal button');

    status.textContent = '⏳ Загрузка...';
    btn.disabled = true;

    try {
        // Конвертация в Base64
        const base64 = await fileToBase64(pendingFile);
        const fileName = `assets/img/${Date.now()}_${pendingFile.name.replace(/\s/g, '_')}`;

        // 1. Загружаем картинку в GitHub
        await githubAPI(token, fileName, base64, `Add photo: ${title}`);

        // 2. Обновляем JSON с данными
        await updateGalleryJSON(token, fileName, title, location);

        status.textContent = '✅ Готово!';
        setTimeout(() => location.reload(), 800); // Перезагрузка для отображения нового фото

    } catch (err) {
        status.textContent = '❌ ' + err.message;
        btn.disabled = false;
    }
}

// === Вспомогательные функции ===
function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

async function githubAPI(token, path, content, message) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/contents/${path}`, {
        method: 'PUT',
        headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, content, branch: BRANCH })
    });
    if (!res.ok) throw new Error('Ошибка сети или токена');
}

async function updateGalleryJSON(token, imagePath, title, location) {
    const jsonPath = 'data/gallery.json';
    const url = `https://api.github.com/repos/${REPO}/contents/${jsonPath}`;
    
    let current = [], sha = null;
    const getRes = await fetch(url, { headers: { 'Authorization': `token ${token}` } });
    
    if (getRes.ok) {
        const data = await getRes.json();
        try { current = JSON.parse(atob(data.content)); } catch(e) { current = []; }
        sha = data.sha;
    }

    current.push({ title, location, image: imagePath, description: '' });

    await fetch(url, {
        method: 'PUT',
        headers: { 'Authorization': `token ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: `Update gallery`, content: btoa(JSON.stringify(current, null, 2)), branch: BRANCH, sha })
    });
}