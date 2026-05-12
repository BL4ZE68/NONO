import './style.css';

/* ============================================================
   NONO — Photo Gallery — Main Logic
   All bugs from ultra-review fixed:
   - XSS in showSlide (use textContent, not innerHTML)
   - localStorage QuotaExceededError handled
   - handleFiles render race condition fixed
   - Duplicate slideshowInterval on re-open fixed
   - showSlide DOM thrash minimized (persistent img element)
   - Upload ordering: sort by lastModified after all reads
   - confirm() replaced with custom modal
   - Mobile swipe support added
   - Auto-pause on manual navigation
   - Dot indicators
   - Loading spinner during FileReader
   - Accessibility: aria-labels, focus-trap, role=dialog
   ============================================================ */

/* ---------- Helpers ---------- */

function formatDate(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleDateString('fr-FR', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

function sanitizeText(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML; // escaped HTML — safe to use as textContent, not innerHTML
}

/* ---------- Toast ---------- */

const toastContainer = (() => {
    const el = document.createElement('div');
    el.className = 'toast-container';
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
    return el;
})();

function showToast(msg, type = 'info', duration = 3500) {
    const t = document.createElement('div');
    t.className = `toast${type === 'error' ? ' error' : ''}`;
    t.textContent = msg;
    toastContainer.appendChild(t);
    setTimeout(() => {
        t.style.animation = 'toastOut 0.3s ease forwards';
        t.addEventListener('animationend', () => t.remove());
    }, duration);
}

/* ---------- Confirm Modal ---------- */

let modalResolve = null;

const modalOverlay = document.createElement('div');
modalOverlay.className = 'modal-overlay';
modalOverlay.setAttribute('role', 'dialog');
modalOverlay.setAttribute('aria-modal', 'true');
modalOverlay.setAttribute('aria-labelledby', 'modal-title');
modalOverlay.innerHTML = `
    <div class="modal">
        <h3 id="modal-title"></h3>
        <p id="modal-body"></p>
        <div class="modal-actions">
            <button class="btn" id="modal-cancel">Annuler</button>
            <button class="btn btn-danger" id="modal-confirm">Supprimer</button>
        </div>
    </div>
`;
document.body.appendChild(modalOverlay);

const modalTitle   = modalOverlay.querySelector('#modal-title');
const modalBody    = modalOverlay.querySelector('#modal-body');
const modalCancel  = modalOverlay.querySelector('#modal-cancel');
const modalConfirm = modalOverlay.querySelector('#modal-confirm');

function showConfirm(title, body) {
    return new Promise(resolve => {
        modalResolve = resolve;
        modalTitle.textContent = title;
        modalBody.textContent  = body;
        modalOverlay.classList.add('visible');
        // focus the cancel button by default (safer default)
        modalCancel.focus();
    });
}

function closeModal(result) {
    modalOverlay.classList.remove('visible');
    if (modalResolve) { modalResolve(result); modalResolve = null; }
}

modalCancel.addEventListener('click', () => closeModal(false));
modalConfirm.addEventListener('click', () => closeModal(true));

// Close on overlay click
modalOverlay.addEventListener('click', e => {
    if (e.target === modalOverlay) closeModal(false);
});

// Close on Escape, focus-trap inside modal
modalOverlay.addEventListener('keydown', e => {
    const focusable = Array.from(
        modalOverlay.querySelectorAll('button, [tabindex]:not([tabindex="-1"])')
    );
    if (e.key === 'Escape') { closeModal(false); return; }
    if (e.key === 'Tab') {
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    }
});

/* ---------- Loading Spinner ---------- */

const loadingEl = (() => {
    const el = document.createElement('div');
    el.className = 'upload-loading';
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-label', 'Chargement en cours…');
    el.innerHTML = `<div class="spinner"></div><span>Chargement…</span>`;
    document.body.appendChild(el);
    return el;
})();

let loadingCount = 0;
function showLoading() { if (++loadingCount === 1) loadingEl.classList.add('visible'); }
function hideLoading() { if (--loadingCount <= 0) { loadingCount = 0; loadingEl.classList.remove('visible'); } }

/* ---------- State ---------- */

let images = [];         // [{ dataUrl, name, size, type, lastModified }]
let currentSlide  = 0;
let slideshowTimer = null;
let userNavigated  = false; // pause flag

/* ---------- DOM refs ---------- */

const uploadArea         = document.getElementById('upload-area');
const fileInput          = document.getElementById('file-input');
const gallery            = document.getElementById('gallery');
const selectFilesBtn     = document.getElementById('select-files');
const startSlideshowBtn  = document.getElementById('start-slideshow');
const clearGalleryBtn    = document.getElementById('clear-gallery');
const closeSlideshowBtn  = document.getElementById('close-slideshow');
const prevSlideBtn       = document.getElementById('prev-slide');
const nextSlideBtn       = document.getElementById('next-slide');
const slideshowContainer = document.getElementById('slideshow');
const slidesContainer    = document.getElementById('slides');
const currentSlideEl     = document.getElementById('current-slide');
const totalSlidesEl      = document.getElementById('total-slides');

// Dot container (injected)
const dotsContainer = document.createElement('div');
dotsContainer.className = 'slide-dots';
dotsContainer.setAttribute('aria-label', 'Navigation par points');
slideshowContainer?.insertBefore(dotsContainer, slidesContainer?.nextSibling ?? null);

// Persistent slide image element (no DOM thrash)
const slideImg = document.createElement('img');
slideImg.setAttribute('draggable', 'false');

const slideInfoEl = document.createElement('div');
slideInfoEl.className = 'slide-info';

const slideTitle = document.createElement('div');
slideTitle.className = 'slide-title';

const slideDate = document.createElement('div');
slideDate.className = 'slide-date';

slideInfoEl.appendChild(slideTitle);
slideInfoEl.appendChild(slideDate);

/* ---------- Persist ---------- */

function saveImages() {
    try {
        localStorage.setItem('galleryImages', JSON.stringify(images));
    } catch (e) {
        if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') {
            showToast(
                'Stockage plein — impossible de sauvegarder toutes les photos. ' +
                'Supprimez des images pour libérer de la place.',
                'error',
                6000
            );
        } else {
            console.error('saveImages:', e);
        }
    }
}

function loadImages() {
    const saved = localStorage.getItem('galleryImages');
    if (!saved) return;
    try {
        images = JSON.parse(saved);
        renderGallery();
        updateCounters();
    } catch (e) {
        console.error('Erreur lors du chargement des images:', e);
        localStorage.removeItem('galleryImages');
    }
}

/* ---------- Gallery Render ---------- */

function renderGallery() {
    if (!gallery) return;

    if (images.length === 0) {
        gallery.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'empty-gallery';
        empty.innerHTML = `
            <i class="fas fa-images" aria-hidden="true"></i>
            <p>Aucune image pour le moment</p>
            <p>Glissez-déposez des images ou cliquez pour sélectionner</p>
        `;
        gallery.appendChild(empty);
        return;
    }

    gallery.innerHTML = '';
    images.forEach((imageData, index) => {
        const item = document.createElement('div');
        item.className = 'gallery-item';
        item.dataset.index = index;
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'button');
        item.setAttribute('aria-label', `Voir ${imageData.name || `Photo ${index + 1}`} en plein écran`);

        const img = document.createElement('img');
        img.src      = imageData.dataUrl;
        img.alt      = imageData.name || `Photo ${index + 1}`;
        img.loading  = 'lazy';
        img.decoding = 'async';

        const del = document.createElement('button');
        del.className = 'delete-btn';
        del.setAttribute('aria-label', `Supprimer ${imageData.name || `Photo ${index + 1}`}`);
        del.innerHTML = '<i class="fas fa-trash" aria-hidden="true"></i>';
        del.addEventListener('click', e => { e.stopPropagation(); deleteImage(index); });

        item.appendChild(img);
        item.appendChild(del);

        item.addEventListener('click', () => startSlideshow(index));
        item.addEventListener('keydown', e => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); startSlideshow(index); }
        });

        gallery.appendChild(item);
    });
}

/* ---------- Delete / Clear ---------- */

async function deleteImage(index) {
    const confirmed = await showConfirm(
        'Supprimer cette photo ?',
        'Cette action est irréversible.'
    );
    if (!confirmed) return;
    images.splice(index, 1);
    saveImages();
    renderGallery();
    updateCounters();

    // If slideshow is open and now empty → close it
    if (slideshowContainer?.classList.contains('active') && images.length === 0) {
        closeSlideshow();
    }
}

async function clearGallery() {
    if (images.length === 0) return;
    const confirmed = await showConfirm(
        'Vider la galerie ?',
        `Toutes les ${images.length} photos seront supprimées. Cette action est irréversible.`
    );
    if (!confirmed) return;
    images = [];
    saveImages();
    renderGallery();
    updateCounters();
    if (slideshowContainer?.classList.contains('active')) closeSlideshow();
}

/* ---------- Slideshow ---------- */

function startSlideshow(startIndex = 0) {
    if (images.length === 0) return;

    // Fix 3-G: always clear before starting to avoid duplicate timers
    clearInterval(slideshowTimer);

    currentSlide = Math.max(0, Math.min(startIndex, images.length - 1));
    rebuildSlide();
    rebuildDots();
    updateCounters();

    slideshowContainer.classList.add('active');
    slideshowContainer.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    // Focus close button for keyboard users
    closeSlideshowBtn?.focus();

    // Auto-advance
    userNavigated = false;
    startAutoAdvance();
}

function startAutoAdvance(delay = 5000) {
    clearInterval(slideshowTimer);
    slideshowTimer = setInterval(() => {
        if (!userNavigated) {
            currentSlide = (currentSlide + 1) % images.length;
            rebuildSlide();
            updateCounters();
        } else {
            userNavigated = false;
        }
    }, delay);
}

function rebuildSlide() {
    // Remove old slide (if any), re-use persistent elements
    slidesContainer.innerHTML = '';

    const data = images[currentSlide];
    slideImg.src = data.dataUrl;
    slideImg.alt = data.name || `Photo ${currentSlide + 1}`;

    // Use textContent — never innerHTML with user data (XSS fix 7-A)
    slideTitle.textContent = data.name || `Photo ${currentSlide + 1}`;
    slideDate.textContent  = formatDate(data.lastModified || Date.now());

    const wrapper = document.createElement('div');
    wrapper.className = 'slide active';
    wrapper.appendChild(slideImg);
    wrapper.appendChild(slideInfoEl);
    slidesContainer.appendChild(wrapper);

    updateActiveDot();
}

function rebuildDots() {
    dotsContainer.innerHTML = '';
    // Only show dots for reasonable counts (≤ 30) to avoid clutter
    if (images.length > 30) return;
    images.forEach((_, i) => {
        const dot = document.createElement('button');
        dot.className = `slide-dot${i === currentSlide ? ' active' : ''}`;
        dot.setAttribute('aria-label', `Aller à la photo ${i + 1}`);
        dot.addEventListener('click', () => goToSlide(i));
        dotsContainer.appendChild(dot);
    });
}

function updateActiveDot() {
    dotsContainer.querySelectorAll('.slide-dot').forEach((d, i) => {
        d.classList.toggle('active', i === currentSlide);
    });
}

function goToSlide(index) {
    currentSlide = (index + images.length) % images.length;
    userNavigated = true;
    // Reset the auto-advance timer on manual nav
    startAutoAdvance(8000);
    rebuildSlide();
    updateCounters();
}

function nextSlide() { goToSlide(currentSlide + 1); }
function prevSlide() { goToSlide(currentSlide - 1); }

function updateCounters() {
    if (currentSlideEl) currentSlideEl.textContent = currentSlide + 1;
    if (totalSlidesEl)  totalSlidesEl.textContent  = images.length;
}

function closeSlideshow() {
    clearInterval(slideshowTimer);
    slideshowContainer.classList.remove('active');
    slideshowContainer.setAttribute('aria-hidden', 'true');
    document.body.style.overflow = '';
}

/* ---------- File Handling ---------- */

function handleFiles(e) {
    const files = Array.from(e.target?.files || e.dataTransfer?.files || []);
    if (files.length === 0) return;

    const imageFiles = files.filter(f => f?.type?.startsWith('image/'));
    if (imageFiles.length === 0) {
        showToast('Aucune image valide sélectionnée.', 'error');
        if (fileInput) fileInput.value = '';
        return;
    }

    showLoading();

    const results   = new Array(imageFiles.length).fill(null);
    let   completed = 0;

    imageFiles.forEach((file, i) => {
        const reader = new FileReader();

        reader.onload = evt => {
            results[i] = {
                dataUrl:      evt.target.result,
                name:         file.name.replace(/\.[^/.]+$/, ''),
                size:         file.size,
                type:         file.type,
                lastModified: file.lastModified || Date.now()
            };
            completed++;
            if (completed === imageFiles.length) finish();
        };

        reader.onerror = () => {
            results[i] = null; // skip
            completed++;
            showToast(`Erreur de lecture : ${file.name}`, 'error');
            if (completed === imageFiles.length) finish();
        };

        reader.readAsDataURL(file);
    });

    function finish() {
        // Sort by lastModified desc (newest first) — deterministic order (fix 3-E)
        const valid = results
            .filter(Boolean)
            .sort((a, b) => b.lastModified - a.lastModified);

        images.unshift(...valid);
        saveImages();
        renderGallery();
        updateCounters();
        hideLoading();

        if (fileInput) fileInput.value = '';

        if (valid.length > 0) {
            showToast(
                valid.length === 1
                    ? '1 photo ajoutée ✓'
                    : `${valid.length} photos ajoutées ✓`
            );
        }
    }
}

/* ---------- Drag & Drop ---------- */

function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
function highlight()   { uploadArea?.classList.add('dragover'); }
function unhighlight() { uploadArea?.classList.remove('dragover'); }

function handleDrop(e) {
    preventDefaults(e);
    unhighlight();
    if (e.dataTransfer?.files?.length) {
        handleFiles({ dataTransfer: e.dataTransfer });
    }
}

/* ---------- Keyboard navigation ---------- */

function handleKeyDown(e) {
    if (!slideshowContainer?.classList.contains('active')) return;
    switch (e.key) {
        case 'ArrowLeft':  e.preventDefault(); prevSlide(); break;
        case 'ArrowRight':
        case ' ':          e.preventDefault(); nextSlide(); break;
        case 'Escape':     closeSlideshow(); break;
    }
}

/* ---------- Touch / Swipe ---------- */

let touchStartX = 0;
let touchStartY = 0;

slideshowContainer?.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].clientX;
    touchStartY = e.changedTouches[0].clientY;
}, { passive: true });

slideshowContainer?.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    const dy = e.changedTouches[0].clientY - touchStartY;
    // Only register as horizontal swipe if Δx > Δy (avoids conflict with scroll)
    if (Math.abs(dx) > Math.abs(dy) && Math.abs(dx) > 40) {
        if (dx < 0) nextSlide(); else prevSlide();
    }
}, { passive: true });

/* ---------- Ambient glow on mousemove ---------- */

const glowEl = document.querySelector('.glow');
if (glowEl) {
    document.addEventListener('mousemove', e => {
        const x = (e.clientX / window.innerWidth  * 100).toFixed(1);
        const y = (e.clientY / window.innerHeight * 100).toFixed(1);
        glowEl.style.setProperty('--gx', `${x}%`);
        glowEl.style.setProperty('--gy', `${y}%`);
    }, { passive: true });
}

/* ---------- Init ---------- */

document.addEventListener('DOMContentLoaded', () => {
    // Button listeners
    selectFilesBtn?.addEventListener('click',  () => fileInput?.click());
    startSlideshowBtn?.addEventListener('click', () => startSlideshow(0));
    clearGalleryBtn?.addEventListener('click',  clearGallery);
    closeSlideshowBtn?.addEventListener('click', closeSlideshow);
    prevSlideBtn?.addEventListener('click', prevSlide);
    nextSlideBtn?.addEventListener('click', nextSlide);

    // Drag & drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(evt => {
        uploadArea?.addEventListener(evt, preventDefaults, false);
    });
    ['dragenter', 'dragover'].forEach(evt => {
        uploadArea?.addEventListener(evt, highlight, false);
    });
    ['dragleave', 'drop'].forEach(evt => {
        uploadArea?.addEventListener(evt, unhighlight, false);
    });
    uploadArea?.addEventListener('drop', handleDrop, false);

    // File input change
    fileInput?.addEventListener('change', handleFiles);

    // Keyboard
    document.addEventListener('keydown', handleKeyDown);

    // Focus-trap in slideshow
    slideshowContainer?.addEventListener('keydown', e => {
        if (!slideshowContainer.classList.contains('active')) return;
        if (e.key !== 'Tab') return;
        const focusable = Array.from(
            slideshowContainer.querySelectorAll(
                'button:not([disabled]), [tabindex]:not([tabindex="-1"])'
            )
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last  = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault(); first.focus();
        }
    });

    // Initial gallery render
    loadImages();
});