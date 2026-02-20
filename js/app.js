// PDF Flipbook — ES Module
// Uploads PDF to server for persistent shareable links, or loads from /view/:id URL

const pdfjsLib = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.min.mjs');
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.9.155/pdf.worker.min.mjs';

(function () {
    'use strict';

    // ─── DOM ───
    const uploadScreen = document.getElementById('upload-screen');
    const uploadZone = document.getElementById('upload-zone');
    const fileInput = document.getElementById('file-input');
    const progressContainer = document.getElementById('progress-container');
    const progressText = document.getElementById('progress-text');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressDetail = document.getElementById('progress-detail');
    const shareBanner = document.getElementById('share-banner');
    const shareUrl = document.getElementById('share-url');
    const copyLinkBtn = document.getElementById('copy-link-btn');
    const flipbookContainer = document.getElementById('flipbook-container');
    const canvas = document.getElementById('flipbook-canvas');
    const ctx = canvas.getContext('2d');
    const navLeft = document.getElementById('nav-left');
    const navRight = document.getElementById('nav-right');
    const pageIndicator = document.getElementById('page-indicator');
    const changePdfBtn = document.getElementById('change-pdf-btn');
    const hint = document.getElementById('hint');

    // ─── State ───
    let pages = [], currentPage = 0, totalPages = 0;
    let pageW = 0, pageH = 0, dpr = 1, pageRatio = 21 / 29.7;
    let isDragging = false, isAnimating = false, flipDirection = 0;
    let cornerOrigin = { x: 0, y: 0 }, pointerPos = { x: 0, y: 0 };
    let audioCtx = null;

    // ═══════════════════════════════════════════
    // INIT — check URL for /view/:id
    // ═══════════════════════════════════════════

    function init() {
        setupUploadEvents();

        // Check if we're on a /view/:id URL
        const match = window.location.pathname.match(/^\/view\/([a-f0-9]+)$/i);
        if (match) {
            const id = match[1];
            uploadScreen.classList.add('hidden');
            showProgress();
            progressText.textContent = 'Loading flipbook…';
            loadPDFFromServer(id);
        }
    }

    // ═══════════════════════════════════════════
    // UPLOAD & PDF LOADING
    // ═══════════════════════════════════════════

    function setupUploadEvents() {
        uploadZone.addEventListener('click', () => fileInput.click());
        uploadZone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
        fileInput.addEventListener('change', e => { if (e.target.files[0]) handleFileUpload(e.target.files[0]); });

        uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag-over'); });
        uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
        uploadZone.addEventListener('drop', e => {
            e.preventDefault(); uploadZone.classList.remove('drag-over');
            const file = e.dataTransfer.files[0];
            if (file && file.type === 'application/pdf') handleFileUpload(file);
        });

        changePdfBtn.addEventListener('click', resetToUpload);

        copyLinkBtn.addEventListener('click', () => {
            shareUrl.select();
            navigator.clipboard.writeText(shareUrl.value).then(() => {
                copyLinkBtn.textContent = '✓ Copied!';
                setTimeout(() => { copyLinkBtn.textContent = 'Copy'; }, 2000);
            }).catch(() => {
                document.execCommand('copy');
                copyLinkBtn.textContent = '✓ Copied!';
                setTimeout(() => { copyLinkBtn.textContent = 'Copy'; }, 2000);
            });
        });
    }

    function showProgress() {
        uploadZone.classList.add('hidden');
        progressContainer.classList.remove('hidden');
        progressBarFill.style.width = '0%';
        progressDetail.textContent = '';
    }

    async function handleFileUpload(file) {
        showProgress();
        progressText.textContent = 'Uploading PDF…';

        try {
            // 1. Upload to server
            const formData = new FormData();
            formData.append('pdf', file);
            const res = await fetch('/api/upload', { method: 'POST', body: formData });
            if (!res.ok) throw new Error('Upload failed');
            const { id } = await res.json();

            // 2. Show share link
            const fullUrl = window.location.origin + '/view/' + id;
            shareUrl.value = fullUrl;
            shareBanner.classList.remove('hidden');

            // 3. Update browser URL without reload
            history.pushState(null, '', '/view/' + id);

            // 4. Render PDF pages
            await loadPDFFromServer(id);

        } catch (err) {
            progressText.textContent = 'Error: ' + err.message;
            console.error(err);
            setTimeout(resetToUpload, 2500);
        }
    }

    async function loadPDFFromServer(id) {
        try {
            progressText.textContent = 'Loading PDF…';
            const pdfUrl = '/api/pdf/' + id;
            const pdfDoc = await pdfjsLib.getDocument(pdfUrl).promise;
            const numPages = pdfDoc.numPages;

            // Get ratio from first page
            const firstPage = await pdfDoc.getPage(1);
            const vp0 = firstPage.getViewport({ scale: 1 });
            pageRatio = vp0.width / vp0.height;

            progressText.textContent = 'Rendering pages…';
            const rendered = [];

            for (let i = 1; i <= numPages; i++) {
                progressDetail.textContent = 'Page ' + i + ' of ' + numPages;
                progressBarFill.style.width = ((i - 1) / numPages * 100) + '%';
                const page = await pdfDoc.getPage(i);
                rendered.push(await renderPDFPage(page));
            }

            progressBarFill.style.width = '100%';
            progressText.textContent = 'Done!';

            // Show share banner if on a /view/ URL
            const match = window.location.pathname.match(/^\/view\/([a-f0-9]+)$/i);
            if (match) {
                shareUrl.value = window.location.origin + '/view/' + match[1];
                shareBanner.classList.remove('hidden');
            }

            setTimeout(() => {
                pages = rendered; totalPages = pages.length; currentPage = 0;
                showFlipbook();
            }, 300);

        } catch (err) {
            progressText.textContent = 'Error loading PDF';
            progressDetail.textContent = err.message;
            console.error(err);
        }
    }

    async function renderPDFPage(page) {
        const targetWidth = Math.min(1600, window.innerWidth * 2);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = targetWidth / vp0.width;
        const viewport = page.getViewport({ scale });
        const offscreen = document.createElement('canvas');
        offscreen.width = viewport.width; offscreen.height = viewport.height;
        await page.render({ canvasContext: offscreen.getContext('2d'), viewport }).promise;
        return new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.src = offscreen.toDataURL('image/png');
        });
    }

    function showFlipbook() {
        uploadScreen.classList.add('hidden');
        progressContainer.classList.add('hidden');
        flipbookContainer.classList.remove('hidden');
        hint.classList.remove('hidden');
        calculateDimensions(); render(); updateUI(); bindFlipbookEvents();

        // Hint curl
        setTimeout(() => {
            if (isAnimating || isDragging || totalPages < 2) return;
            flipDirection = 1; cornerOrigin = { x: pageW, y: pageH }; isAnimating = true;
            const dur = 900, t0 = performance.now(), px = pageW * 0.78, py = pageH * 0.82;
            (function step(now) {
                const t = Math.min((now - t0) / dur, 1);
                if (t < 0.45) { const e = Math.sin((t / 0.45) * Math.PI / 2); pointerPos = { x: pageW + (px - pageW) * e, y: pageH + (py - pageH) * e }; }
                else { const e = 1 - Math.pow(1 - (t - 0.45) / 0.55, 2); pointerPos = { x: px + (pageW - px) * e, y: py + (pageH - py) * e }; }
                render();
                if (t < 1) requestAnimationFrame(step);
                else { isAnimating = false; flipDirection = 0; render(); }
            })(performance.now());
        }, 600);
    }

    function resetToUpload() {
        flipbookContainer.classList.add('hidden');
        hint.classList.add('hidden');
        shareBanner.classList.add('hidden');
        uploadScreen.classList.remove('hidden');
        uploadZone.classList.remove('hidden');
        progressContainer.classList.add('hidden');
        fileInput.value = '';
        pages = []; totalPages = 0; currentPage = 0;
        isDragging = false; isAnimating = false; flipDirection = 0;
        history.pushState(null, '', '/');
    }

    // ═══════════════════════════════════════════
    // AUDIO
    // ═══════════════════════════════════════════
    function initAudio() { if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    function playFlipSound() {
        if (!audioCtx) return;
        try {
            const now = audioCtx.currentTime, sr = audioCtx.sampleRate;
            const g = audioCtx.createBuffer(1, Math.round(sr * 0.06), sr), gd = g.getChannelData(0);
            for (let i = 0; i < gd.length; i++) gd[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 60) * 0.22;
            const gs = audioCtx.createBufferSource(); gs.buffer = g;
            const gf = audioCtx.createBiquadFilter(); gf.type = 'bandpass'; gf.frequency.value = 3200; gf.Q.value = 1.2;
            gs.connect(gf).connect(audioCtx.destination); gs.start(now);
            const s = audioCtx.createBuffer(1, Math.round(sr * 0.28), sr), sd = s.getChannelData(0);
            for (let i = 0; i < sd.length; i++) sd[i] = (Math.random() * 2 - 1) * Math.exp(-Math.pow(((i / sr) - 0.08) / 0.06, 2)) * 0.14;
            for (let p = 0; p < 3; p++) for (let i = 1; i < sd.length - 1; i++) sd[i] = (sd[i - 1] + sd[i] * 2 + sd[i + 1]) / 4;
            const ss = audioCtx.createBufferSource(); ss.buffer = s;
            const sf = audioCtx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 2500;
            ss.connect(sf).connect(audioCtx.destination); ss.start(now + 0.02);
            const o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 75;
            const og = audioCtx.createGain(); og.gain.setValueAtTime(0, now + 0.2);
            og.gain.linearRampToValueAtTime(0.07, now + 0.22); og.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
            o.connect(og).connect(audioCtx.destination); o.start(now + 0.2); o.stop(now + 0.4);
        } catch (_) { }
    }

    // ═══════════════════════════════════════════
    // SIZING + GEOMETRY + RENDERING (same as before)
    // ═══════════════════════════════════════════
    function calculateDimensions() {
        const vw = window.innerWidth, vh = window.innerHeight, mob = vw <= 768;
        let tw = mob ? vw * 0.93 : vw * 0.85, th = tw / pageRatio;
        if (th > vh * 0.85) { th = vh * 0.85; tw = th * pageRatio; }
        pageW = Math.round(Math.max(tw, 260)); pageH = Math.round(pageW / pageRatio);
        dpr = window.devicePixelRatio || 1;
        canvas.width = pageW * dpr; canvas.height = pageH * dpr;
        canvas.style.width = pageW + 'px'; canvas.style.height = pageH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function computeFold(corner, pointer) {
        const dx = pointer.x - corner.x, dy = pointer.y - corner.y, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 1) return null;
        return { mx: (corner.x + pointer.x) / 2, my: (corner.y + pointer.y) / 2, fdx: -dy / dist, fdy: dx / dist, fnx: -dx / dist, fny: -dy / dist, dist };
    }

    function constrainPointer(corner, ptr) {
        let px = ptr.x, py = ptr.y; const m = 30;
        if ((corner.x + px) / 2 < -m) px = -2 * m - corner.x; if ((corner.x + px) / 2 > pageW + m) px = 2 * (pageW + m) - corner.x;
        if ((corner.y + py) / 2 < -m) py = -2 * m - corner.y; if ((corner.y + py) / 2 > pageH + m) py = 2 * (pageH + m) - corner.y;
        return { x: px, y: py };
    }

    function clipFold(f, cornerSide, curv) {
        const sign = cornerSide ? 1 : -1, ext = (pageW + pageH) * 2;
        const lx1 = f.mx - f.fdx * ext, ly1 = f.my - f.fdy * ext, lx2 = f.mx + f.fdx * ext, ly2 = f.my + f.fdy * ext;
        const ox = f.fnx * ext * sign, oy = f.fny * ext * sign;
        const cpx = f.mx - f.fnx * curv, cpy = f.my - f.fny * curv;
        ctx.beginPath(); ctx.moveTo(lx1, ly1);
        if (curv > 0.5) ctx.quadraticCurveTo(cpx, cpy, lx2, ly2); else ctx.lineTo(lx2, ly2);
        ctx.lineTo(lx2 + ox, ly2 + oy); ctx.lineTo(lx1 + ox, ly1 + oy); ctx.closePath(); ctx.clip();
    }

    function reflectAcrossFold(f) {
        const nx = f.fnx, ny = f.fny, d = nx * f.mx + ny * f.my;
        ctx.transform(1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, 2 * nx * d, 2 * ny * d);
    }

    function render() {
        ctx.clearRect(0, 0, pageW, pageH);
        if (totalPages === 0) return;
        if (isDragging || isAnimating) renderCurl(); else drawPage(currentPage);
    }

    function drawPage(idx) {
        if (idx >= 0 && idx < totalPages) ctx.drawImage(pages[idx], 0, 0, pageW, pageH);
        else { ctx.fillStyle = '#f5f0e8'; ctx.fillRect(0, 0, pageW, pageH); }
    }

    function renderCurl() {
        const cPtr = constrainPointer(cornerOrigin, pointerPos);
        const f = computeFold(cornerOrigin, cPtr);
        if (!f) { drawPage(currentPage); return; }
        const diag = Math.sqrt(pageW * pageW + pageH * pageH), progress = Math.min(1, f.dist / diag);
        const curv = Math.sin(progress * Math.PI) * pageW * 0.06;
        const revIdx = flipDirection === 1 ? currentPage + 1 : currentPage - 1;

        // Layer 1: Revealed page (corner side)
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipFold(f, true, curv);
        drawPage(revIdx);
        const sw = Math.min(70, pageW * progress * 0.25);
        if (sw > 2) { const sg = ctx.createLinearGradient(f.mx + f.fnx, f.my + f.fny, f.mx + f.fnx * sw, f.my + f.fny * sw); const sa = Math.min(0.45, progress * 0.55); sg.addColorStop(0, 'rgba(0,0,0,' + sa + ')'); sg.addColorStop(0.35, 'rgba(0,0,0,' + sa * 0.35 + ')'); sg.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = sg; ctx.fillRect(-50, -50, pageW + 100, pageH + 100); }
        ctx.restore();

        // Layer 2: Current page (kept side)
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipFold(f, false, curv);
        drawPage(currentPage); ctx.restore();

        // Layer 3: Curl back (kept side, reflected)
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipFold(f, false, curv);
        ctx.save(); reflectAcrossFold(f); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipFold(f, true, curv);
        ctx.fillStyle = '#efe9df'; ctx.fillRect(0, 0, pageW, pageH);
        ctx.globalAlpha = 0.05; drawPage(currentPage); ctx.globalAlpha = 1; ctx.restore();
        const cw = Math.max(20, f.dist * 0.5);
        const cg = ctx.createLinearGradient(f.mx - f.fnx, f.my - f.fny, f.mx - f.fnx * cw, f.my - f.fny * cw);
        cg.addColorStop(0, 'rgba(0,0,0,0.2)'); cg.addColorStop(0.1, 'rgba(255,255,255,0.06)'); cg.addColorStop(0.3, 'rgba(0,0,0,0.04)'); cg.addColorStop(0.7, 'rgba(255,255,255,0.02)'); cg.addColorStop(1, 'rgba(0,0,0,0.1)');
        ctx.fillStyle = cg; ctx.fillRect(-50, -50, pageW + 100, pageH + 100); ctx.restore();

        // Layer 4: Fold edge
        if (progress > 0.01) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); const ext = (pageW + pageH) * 2; const cpx = f.mx - f.fnx * curv, cpy = f.my - f.fny * curv; ctx.beginPath(); ctx.moveTo(f.mx - f.fdx * ext, f.my - f.fdy * ext); if (curv > 0.5) ctx.quadraticCurveTo(cpx, cpy, f.mx + f.fdx * ext, f.my + f.fdy * ext); else ctx.lineTo(f.mx + f.fdx * ext, f.my + f.fdy * ext); ctx.strokeStyle = 'rgba(80,70,60,' + Math.min(0.3, progress * 0.4) + ')'; ctx.lineWidth = Math.min(1.8, progress * 2.5); ctx.stroke(); ctx.restore(); }

        // Layer 5: Front highlight
        if (progress > 0.015) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipFold(f, false, curv); const hw = Math.min(25, pageW * progress * 0.12); const hg = ctx.createLinearGradient(f.mx - f.fnx, f.my - f.fny, f.mx - f.fnx * hw, f.my - f.fny * hw); hg.addColorStop(0, 'rgba(255,255,255,' + Math.min(0.14, progress * 0.18) + ')'); hg.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = hg; ctx.fillRect(-50, -50, pageW + 100, pageH + 100); ctx.restore(); }
    }

    // ═══════════════════════════════════════════
    // INTERACTION
    // ═══════════════════════════════════════════
    function getPointerPos(e) {
        const r = canvas.getBoundingClientRect(), cx = e.touches ? e.touches[0].clientX : e.clientX, cy = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: (cx - r.left) * (pageW / r.width), y: (cy - r.top) * (pageH / r.height) };
    }

    function onPointerDown(e) {
        if (isAnimating) return; initAudio();
        const pos = getPointerPos(e), ez = pageW * 0.30;
        if (pos.x > pageW - ez && currentPage < totalPages - 1) { isDragging = true; flipDirection = 1; cornerOrigin = { x: pageW, y: pos.y > pageH / 2 ? pageH : 0 }; pointerPos = { x: pos.x, y: pos.y }; canvas.style.cursor = 'grabbing'; render(); return; }
        if (pos.x < ez && currentPage > 0) { isDragging = true; flipDirection = -1; cornerOrigin = { x: 0, y: pos.y > pageH / 2 ? pageH : 0 }; pointerPos = { x: pos.x, y: pos.y }; canvas.style.cursor = 'grabbing'; render(); return; }
    }

    function onPointerMove(e) {
        if (!isDragging) { const p = getPointerPos(e), ez = pageW * 0.30; canvas.style.cursor = ((p.x > pageW - ez && currentPage < totalPages - 1) || (p.x < ez && currentPage > 0)) ? 'grab' : 'default'; return; }
        e.preventDefault(); pointerPos = getPointerPos(e); render();
    }

    function onPointerUp() {
        if (!isDragging) return; isDragging = false; canvas.style.cursor = 'default';
        const cPtr = constrainPointer(cornerOrigin, pointerPos), f = computeFold(cornerOrigin, cPtr);
        const diag = Math.sqrt(pageW * pageW + pageH * pageH), progress = f ? Math.min(1, f.dist / diag) : 0;
        if (progress > 0.18) animateComplete(); else animateSnapBack();
    }

    // ═══════════════════════════════════════════
    // ANIMATIONS
    // ═══════════════════════════════════════════
    function animateComplete() {
        isAnimating = true; const start = { x: pointerPos.x, y: pointerPos.y };
        const target = { x: cornerOrigin.x === pageW ? -pageW * 0.35 : pageW * 1.35, y: cornerOrigin.y };
        playFlipSound(); const t0 = performance.now(), dur = 480;
        function step(now) { const t = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - t, 3); pointerPos = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e }; render(); if (t < 1) requestAnimationFrame(step); else { currentPage += flipDirection; isAnimating = false; flipDirection = 0; render(); updateUI(); } }
        requestAnimationFrame(step);
    }

    function animateSnapBack() {
        isAnimating = true; const start = { x: pointerPos.x, y: pointerPos.y }, target = { x: cornerOrigin.x, y: cornerOrigin.y };
        const t0 = performance.now(), dur = 320;
        function step(now) { const t = Math.min((now - t0) / dur, 1), e = Math.min(1, 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 0.3)); pointerPos = { x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e }; render(); if (t < 1) requestAnimationFrame(step); else { isAnimating = false; flipDirection = 0; render(); } }
        requestAnimationFrame(step);
    }

    function autoFlip(dir) {
        if (isAnimating || isDragging) return;
        if (currentPage + dir < 0 || currentPage + dir >= totalPages) return;
        initAudio(); flipDirection = dir;
        cornerOrigin = { x: dir === 1 ? pageW : 0, y: pageH };
        pointerPos = { x: dir === 1 ? pageW - 3 : 3, y: pageH - 3 };
        animateComplete();
    }

    function updateUI() {
        pageIndicator.textContent = (currentPage + 1) + ' / ' + totalPages;
        navLeft.classList.toggle('disabled', currentPage <= 0);
        navRight.classList.toggle('disabled', currentPage >= totalPages - 1);
    }

    let bound = false;
    function bindFlipbookEvents() {
        if (bound) return; bound = true;
        canvas.addEventListener('mousedown', onPointerDown);
        window.addEventListener('mousemove', onPointerMove);
        window.addEventListener('mouseup', onPointerUp);
        canvas.addEventListener('touchstart', onPointerDown, { passive: true });
        window.addEventListener('touchmove', onPointerMove, { passive: false });
        window.addEventListener('touchend', onPointerUp);
        navLeft.addEventListener('click', () => autoFlip(-1));
        navRight.addEventListener('click', () => autoFlip(1));
        document.addEventListener('keydown', e => {
            if (flipbookContainer.classList.contains('hidden')) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') autoFlip(1);
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') autoFlip(-1);
        });
        window.addEventListener('resize', () => { if (!flipbookContainer.classList.contains('hidden')) { calculateDimensions(); render(); } });
    }

    init();
})();
