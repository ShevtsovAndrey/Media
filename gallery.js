document.addEventListener('DOMContentLoaded', () => {
    const gallery = document.getElementById('gallery');

    fetch('data/gallery.json')
        .then(res => {
            if (!res.ok) throw new Error('Network error');
            return res.json();
        })
        .then(photos => {
            gallery.innerHTML = ''; // Очистка
            
            photos.forEach(photo => {
                const card = document.createElement('div');
                card.className = 'photo-card';
                
                // Если фото нет, ставим заглушку
                const imgSrc = photo.image || photo.src || 'assets/img/placeholder.jpg';
                
                card.innerHTML = `
                    <img src="${imgSrc}" alt="${photo.title}" loading="lazy">
                    <div class="photo-info">
                        <h3>${photo.title}</h3>
                        <p>📍 ${photo.location}</p>
                    </div>
                `;
                
                gallery.appendChild(card);
            });
        })
        .catch(err => {
            console.log('Галерея пуста или ошибка загрузки:', err);
            gallery.innerHTML = '<p style="color:#666; padding:20px;">Загрузи фото через /upload.html</p>';
        });
});