document.addEventListener('DOMContentLoaded', () => {
  const grid = document.getElementById('gallery-grid');
  const locFilter = document.getElementById('location-filter');
  const colFilter = document.getElementById('color-filter');
  const sortSelect = document.getElementById('sort-by');

  let photos = [];

  // 1. Загрузка данных из JSON
  fetch('data/gallery.json')
    .then(res => {
      if (!res.ok) throw new Error('Файл галереи не найден. Загрузите хотя бы 1 фото через админку.');
      return res.json();
    })
    .then(data => {
      photos = data;
      populateFilters();
      renderGallery();
    })
    .catch(err => console.error(err));

  // 2. Заполнение фильтров уникальными значениями
  function populateFilters() {
    const locations = [...new Set(photos.map(p => p.location))].sort();
    locations.forEach(loc => {
      const opt = document.createElement('option');
      opt.value = loc; opt.textContent = loc;
      locFilter.appendChild(opt);
    });

    // Цвета пока пустые, заполнятся после анализа
  }

  // 3. Рендер карточек
  function renderGallery() {
    grid.innerHTML = '';
    const loc = locFilter.value;
    const col = colFilter.value;
    const sort = sortSelect.value;

    let filtered = photos.filter(p => (loc === 'all' || p.location === loc));
    if (col !== 'all') {
      filtered = filtered.filter(p => p._extractedColor === col);
    }

    if (sort === 'location') {
      filtered.sort((a, b) => a.location.localeCompare(b.location));
    }
    // 'new' - порядок по умолчанию (как в JSON, т.е. последние добавленные)

    filtered.forEach(photo => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = `
        <img src="${photo.image}" alt="${photo.title}" loading="lazy" crossorigin="anonymous">
        <div class="card-content">
          <div class="card-title">${photo.title}</div>
          ${photo.description ? `<div style="font-size:0.9rem;color:#aaa;margin-top:0.2rem">${photo.description}</div>` : ''}
          <div class="card-meta">
            <span>📍 ${photo.location}</span>
            <span class="color-swatch" style="background:var(--dominant-color, #555)"></span>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });

    // 4. Запуск анализа цвета для отрендеренных изображений
    analyzeColors();
  }

  // 5. Анализ доминантного цвета
  function analyzeColors() {
    const colorThief = new ColorThief();
    const imgs = grid.querySelectorAll('img');
    const colors = new Set();

    imgs.forEach(img => {
      // Ждём загрузки каждого изображения
      img.onload = () => {
        try {
          const rgb = colorThief.getColor(img); // [r, g, b]
          const hex = rgbToHex(...rgb);
          img.style.setProperty('--dominant-color', hex);
          colors.add(hex);
        } catch (e) {
          console.warn('Не удалось извлечь цвет:', img.src);
        }
      };
      // Если кэш браузера уже загрузил картинку, onload не сработает
      if (img.complete) img.onload();
    });

    // Обновляем фильтр по цветам (ограничиваем до 6 основных)
    updateColorFilter([...colors].slice(0, 6));
  }

  function updateColorFilter(hexArray) {
    // Сохраняем старые опции "Все цвета"
    colFilter.innerHTML = '<option value="all">Все цвета</option>';
    hexArray.forEach(hex => {
      const opt = document.createElement('option');
      opt.value = hex;
      opt.textContent = hex;
      colFilter.appendChild(opt);
    });
  }

  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
  }

  // 6. Обработчики фильтров
  [locFilter, colFilter, sortSelect].forEach(el => {
    el.addEventListener('change', renderGallery);
  });
});