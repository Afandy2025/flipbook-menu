/*  PDF Flipbook — app.js
    Loads PDF.js dynamically, handles upload, shareable links, and corner curl flipbook.
*/
(function () {
    'use strict';

    // ─── DOM refs ───
    var $ = function (id) { return document.getElementById(id); };
    var uploadScreen = $('upload-screen');
    var uploadZone = $('upload-zone');
    var fileInput = $('file-input');
    var progressCtr = $('progress-container');
    var progressText = $('progress-text');
    var progressFill = $('progress-bar-fill');
    var progressDetail = $('progress-detail');
    var shareBanner = $('share-banner');
    var shareUrl = $('share-url');
    var copyBtn = $('copy-link-btn');
    var flipCtr = $('flipbook-container');
    var canvas = $('flipbook-canvas');
    var ctx = canvas.getContext('2d');
    var navL = $('nav-left');
    var navR = $('nav-right');
    var pageInd = $('page-indicator');
    var changeBtn = $('change-pdf-btn');
    var hint = $('hint');

    // ─── State ───
    var pages = [], curPage = 0, total = 0;
    var pageW = 0, pageH = 0, dpr = 1, pageRatio = 21 / 29.7;
    var dragging = false, animating = false, flipDir = 0;
    var corner = { x: 0, y: 0 }, pointer = { x: 0, y: 0 };
    var audioCtx = null, pdfLib = null;

    // ═══════════════════════════════════════
    //  LOAD PDF.JS DYNAMICALLY
    // ═══════════════════════════════════════

    function ensurePdfJs() {
        if (pdfLib) return Promise.resolve(pdfLib);
        return new Promise(function (resolve, reject) {
            // Check if already loaded globally
            if (window.pdfjsLib) {
                pdfLib = window.pdfjsLib;
                pdfLib.GlobalWorkerOptions.workerSrc =
                    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                return resolve(pdfLib);
            }
            var script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            script.onload = function () {
                pdfLib = window.pdfjsLib;
                if (!pdfLib) return reject(new Error('PDF.js failed to initialize'));
                pdfLib.GlobalWorkerOptions.workerSrc =
                    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                resolve(pdfLib);
            };
            script.onerror = function () { reject(new Error('Failed to load PDF.js library')); };
            document.head.appendChild(script);
        });
    }

    // ═══════════════════════════════════════
    //  UPLOAD UI
    // ═══════════════════════════════════════

    function openFilePicker() {
        fileInput.value = '';        // reset so same file can be re-selected
        fileInput.click();
    }

    uploadZone.addEventListener('click', openFilePicker);
    uploadZone.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFilePicker(); }
    });

    fileInput.addEventListener('change', function () {
        var f = fileInput.files[0];
        if (f) handleUpload(f);
    });

    // Drag & drop
    uploadZone.addEventListener('dragover', function (e) { e.preventDefault(); e.stopPropagation(); uploadZone.classList.add('drag-over'); });
    uploadZone.addEventListener('dragleave', function (e) { e.preventDefault(); uploadZone.classList.remove('drag-over'); });
    uploadZone.addEventListener('drop', function (e) {
        e.preventDefault(); e.stopPropagation(); uploadZone.classList.remove('drag-over');
        var f = e.dataTransfer && e.dataTransfer.files[0];
        if (f && (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'))) handleUpload(f);
    });

    // Change PDF button
    changeBtn.addEventListener('click', resetToUpload);

    // Copy link
    copyBtn.addEventListener('click', function () {
        shareUrl.select();
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(shareUrl.value).then(showCopied).catch(showCopied);
        } else {
            try { document.execCommand('copy'); } catch (_) { }
            showCopied();
        }
    });
    function showCopied() {
        copyBtn.textContent = '✓ Copied!';
        setTimeout(function () { copyBtn.textContent = 'Copy Link'; }, 2000);
    }

    // ═══════════════════════════════════════
    //  FILE HANDLING
    // ═══════════════════════════════════════

    function showProgress(msg) {
        uploadZone.classList.add('hidden');
        progressCtr.classList.remove('hidden');
        progressFill.style.width = '0%';
        progressDetail.textContent = '';
        progressText.textContent = msg || 'Processing…';
    }

    function handleUpload(file) {
        showProgress('Uploading PDF…');

        var formData = new FormData();
        formData.append('pdf', file);

        fetch('/api/upload', { method: 'POST', body: formData })
            .then(function (res) {
                if (!res.ok) throw new Error('Upload failed (status ' + res.status + ')');
                return res.json();
            })
            .then(function (data) {
                var link = window.location.origin + '/view/' + data.id;
                shareUrl.value = link;
                shareBanner.classList.remove('hidden');
                try { history.pushState(null, '', '/view/' + data.id); } catch (_) { }
                return loadPDF('/api/pdf/' + data.id);
            })
            .catch(function (err) {
                console.error('Upload error:', err);
                progressText.textContent = 'Upload failed — ' + err.message;
                progressDetail.textContent = 'Trying again in a moment…';
                setTimeout(resetToUpload, 2500);
            });
    }

    function loadPDF(url) {
        showProgress('Loading PDF…');

        return ensurePdfJs()
            .then(function (lib) {
                return lib.getDocument(url).promise;
            })
            .then(function (pdf) {
                var num = pdf.numPages;
                progressText.textContent = 'Rendering pages…';

                return pdf.getPage(1).then(function (p1) {
                    var vp = p1.getViewport({ scale: 1 });
                    pageRatio = vp.width / vp.height;

                    var imgs = [];
                    var chain = Promise.resolve();
                    for (var i = 1; i <= num; i++) {
                        (function (n) {
                            chain = chain.then(function () {
                                progressDetail.textContent = 'Page ' + n + ' of ' + num;
                                progressFill.style.width = ((n - 1) / num * 100) + '%';
                                return pdf.getPage(n).then(renderPage).then(function (img) { imgs.push(img); });
                            });
                        })(i);
                    }

                    return chain.then(function () {
                        progressFill.style.width = '100%';
                        progressText.textContent = 'Ready!';
                        setTimeout(function () {
                            pages = imgs; total = pages.length; curPage = 0;
                            showFlipbook();
                        }, 250);
                    });
                });
            })
            .catch(function (err) {
                console.error('PDF load error:', err);
                progressText.textContent = 'Could not load PDF';
                progressDetail.textContent = err.message;
            });
    }

    function renderPage(page) {
        var tw = Math.min(1600, window.innerWidth * 2);
        var vp0 = page.getViewport({ scale: 1 });
        var scale = tw / vp0.width;
        var vp = page.getViewport({ scale: scale });
        var c = document.createElement('canvas');
        c.width = vp.width; c.height = vp.height;
        return page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () {
            return new Promise(function (ok) {
                var img = new Image();
                img.onload = function () { ok(img); };
                img.src = c.toDataURL('image/png');
            });
        });
    }

    // ═══════════════════════════════════════
    //  VIEW SWITCHING
    // ═══════════════════════════════════════

    function showFlipbook() {
        uploadScreen.classList.add('hidden');
        progressCtr.classList.add('hidden');
        flipCtr.classList.remove('hidden');
        hint.classList.remove('hidden');
        calcSize(); draw(); updateNav(); bindFlip();

        // Hint peek animation
        setTimeout(function () {
            if (animating || dragging || total < 2) return;
            flipDir = 1; corner = { x: pageW, y: pageH }; animating = true;
            var t0 = performance.now(), dur = 900, px = pageW * 0.78, py = pageH * 0.82;
            (function step(now) {
                var t = Math.min((now - t0) / dur, 1);
                if (t < 0.45) { var e = Math.sin((t / 0.45) * Math.PI / 2); pointer = { x: pageW + (px - pageW) * e, y: pageH + (py - pageH) * e }; }
                else { var e2 = 1 - Math.pow(1 - (t - 0.45) / 0.55, 2); pointer = { x: px + (pageW - px) * e2, y: py + (pageH - py) * e2 }; }
                draw();
                if (t < 1) requestAnimationFrame(step); else { animating = false; flipDir = 0; draw(); }
            })(performance.now());
        }, 600);
    }

    function resetToUpload() {
        flipCtr.classList.add('hidden');
        hint.classList.add('hidden');
        shareBanner.classList.add('hidden');
        uploadScreen.classList.remove('hidden');
        uploadZone.classList.remove('hidden');
        progressCtr.classList.add('hidden');
        fileInput.value = '';
        pages = []; total = 0; curPage = 0;
        dragging = false; animating = false; flipDir = 0;
        try { history.pushState(null, '', '/'); } catch (_) { }
    }

    // ═══════════════════════════════════════
    //  AUDIO
    // ═══════════════════════════════════════
    function initAudio() { if (!audioCtx) try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (_) { } }
    function flipSound() {
        if (!audioCtx) return;
        try {
            var now = audioCtx.currentTime, sr = audioCtx.sampleRate;
            var g = audioCtx.createBuffer(1, Math.round(sr * 0.06), sr), gd = g.getChannelData(0);
            for (var i = 0; i < gd.length; i++) gd[i] = (Math.random() * 2 - 1) * Math.exp(-(i / sr) * 60) * 0.22;
            var gs = audioCtx.createBufferSource(); gs.buffer = g;
            var gf = audioCtx.createBiquadFilter(); gf.type = 'bandpass'; gf.frequency.value = 3200; gf.Q.value = 1.2;
            gs.connect(gf).connect(audioCtx.destination); gs.start(now);
            var s = audioCtx.createBuffer(1, Math.round(sr * 0.28), sr), sd = s.getChannelData(0);
            for (var j = 0; j < sd.length; j++) sd[j] = (Math.random() * 2 - 1) * Math.exp(-Math.pow(((j / sr) - 0.08) / 0.06, 2)) * 0.14;
            for (var p = 0; p < 3; p++) for (var k = 1; k < sd.length - 1; k++) sd[k] = (sd[k - 1] + sd[k] * 2 + sd[k + 1]) / 4;
            var ss = audioCtx.createBufferSource(); ss.buffer = s;
            var sf = audioCtx.createBiquadFilter(); sf.type = 'lowpass'; sf.frequency.value = 2500;
            ss.connect(sf).connect(audioCtx.destination); ss.start(now + 0.02);
            var o = audioCtx.createOscillator(); o.type = 'sine'; o.frequency.value = 75;
            var og = audioCtx.createGain(); og.gain.setValueAtTime(0, now + 0.2);
            og.gain.linearRampToValueAtTime(0.07, now + 0.22); og.gain.exponentialRampToValueAtTime(0.001, now + 0.34);
            o.connect(og).connect(audioCtx.destination); o.start(now + 0.2); o.stop(now + 0.4);
        } catch (_) { }
    }

    // ═══════════════════════════════════════
    //  SIZING & GEOMETRY
    // ═══════════════════════════════════════
    function calcSize() {
        var vw = window.innerWidth, vh = window.innerHeight, mob = vw <= 768;
        var tw = mob ? vw * 0.93 : vw * 0.85, th = tw / pageRatio;
        if (th > vh * 0.82) { th = vh * 0.82; tw = th * pageRatio; }
        pageW = Math.round(Math.max(tw, 260)); pageH = Math.round(pageW / pageRatio);
        dpr = window.devicePixelRatio || 1;
        canvas.width = pageW * dpr; canvas.height = pageH * dpr;
        canvas.style.width = pageW + 'px'; canvas.style.height = pageH + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function fold(c, p) {
        var dx = p.x - c.x, dy = p.y - c.y, d = Math.sqrt(dx * dx + dy * dy);
        if (d < 1) return null;
        return { mx: (c.x + p.x) / 2, my: (c.y + p.y) / 2, fdx: -dy / d, fdy: dx / d, fnx: -dx / d, fny: -dy / d, dist: d };
    }

    function clamp(c, p) {
        var x = p.x, y = p.y, m = 30;
        if ((c.x + x) / 2 < -m) x = -2 * m - c.x; if ((c.x + x) / 2 > pageW + m) x = 2 * (pageW + m) - c.x;
        if ((c.y + y) / 2 < -m) y = -2 * m - c.y; if ((c.y + y) / 2 > pageH + m) y = 2 * (pageH + m) - c.y;
        return { x: x, y: y };
    }

    function clipF(f, side, cv) {
        var s = side ? 1 : -1, ext = (pageW + pageH) * 2;
        var lx1 = f.mx - f.fdx * ext, ly1 = f.my - f.fdy * ext;
        var lx2 = f.mx + f.fdx * ext, ly2 = f.my + f.fdy * ext;
        var ox = f.fnx * ext * s, oy = f.fny * ext * s;
        var cpx = f.mx - f.fnx * cv, cpy = f.my - f.fny * cv;
        ctx.beginPath(); ctx.moveTo(lx1, ly1);
        if (cv > 0.5) ctx.quadraticCurveTo(cpx, cpy, lx2, ly2); else ctx.lineTo(lx2, ly2);
        ctx.lineTo(lx2 + ox, ly2 + oy); ctx.lineTo(lx1 + ox, ly1 + oy); ctx.closePath(); ctx.clip();
    }

    function reflect(f) {
        var nx = f.fnx, ny = f.fny, d = nx * f.mx + ny * f.my;
        ctx.transform(1 - 2 * nx * nx, -2 * nx * ny, -2 * nx * ny, 1 - 2 * ny * ny, 2 * nx * d, 2 * ny * d);
    }

    // ═══════════════════════════════════════
    //  RENDERING
    // ═══════════════════════════════════════
    function draw() {
        ctx.clearRect(0, 0, pageW, pageH);
        if (!total) return;
        if (dragging || animating) drawCurl(); else drawPg(curPage);
    }

    function drawPg(i) {
        if (i >= 0 && i < total) ctx.drawImage(pages[i], 0, 0, pageW, pageH);
        else { ctx.fillStyle = '#f5f0e8'; ctx.fillRect(0, 0, pageW, pageH); }
    }

    function drawCurl() {
        var cp = clamp(corner, pointer), f = fold(corner, cp);
        if (!f) { drawPg(curPage); return; }
        var diag = Math.sqrt(pageW * pageW + pageH * pageH);
        var pr = Math.min(1, f.dist / diag);
        var cv = Math.sin(pr * Math.PI) * pageW * 0.06;
        var ri = flipDir === 1 ? curPage + 1 : curPage - 1;

        // L1: revealed
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipF(f, true, cv); drawPg(ri);
        var sw = Math.min(70, pageW * pr * 0.25);
        if (sw > 2) { var sg = ctx.createLinearGradient(f.mx + f.fnx, f.my + f.fny, f.mx + f.fnx * sw, f.my + f.fny * sw); var sa = Math.min(0.45, pr * 0.55); sg.addColorStop(0, 'rgba(0,0,0,' + sa + ')'); sg.addColorStop(0.35, 'rgba(0,0,0,' + sa * 0.35 + ')'); sg.addColorStop(1, 'rgba(0,0,0,0)'); ctx.fillStyle = sg; ctx.fillRect(-50, -50, pageW + 100, pageH + 100); }
        ctx.restore();

        // L2: current (kept)
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipF(f, false, cv); drawPg(curPage); ctx.restore();

        // L3: curl back
        ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipF(f, false, cv);
        ctx.save(); reflect(f); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipF(f, true, cv);
        ctx.fillStyle = '#efe9df'; ctx.fillRect(0, 0, pageW, pageH);
        ctx.globalAlpha = 0.05; drawPg(curPage); ctx.globalAlpha = 1; ctx.restore();
        var cw = Math.max(20, f.dist * 0.5);
        var cg = ctx.createLinearGradient(f.mx - f.fnx, f.my - f.fny, f.mx - f.fnx * cw, f.my - f.fny * cw);
        cg.addColorStop(0, 'rgba(0,0,0,0.2)'); cg.addColorStop(0.1, 'rgba(255,255,255,0.06)'); cg.addColorStop(0.3, 'rgba(0,0,0,0.04)'); cg.addColorStop(0.7, 'rgba(255,255,255,0.02)'); cg.addColorStop(1, 'rgba(0,0,0,0.1)');
        ctx.fillStyle = cg; ctx.fillRect(-50, -50, pageW + 100, pageH + 100); ctx.restore();

        // L4: fold edge
        if (pr > 0.01) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); var ext = (pageW + pageH) * 2; var cpx = f.mx - f.fnx * cv, cpy = f.my - f.fny * cv; ctx.beginPath(); ctx.moveTo(f.mx - f.fdx * ext, f.my - f.fdy * ext); if (cv > 0.5) ctx.quadraticCurveTo(cpx, cpy, f.mx + f.fdx * ext, f.my + f.fdy * ext); else ctx.lineTo(f.mx + f.fdx * ext, f.my + f.fdy * ext); ctx.strokeStyle = 'rgba(80,70,60,' + Math.min(0.3, pr * 0.4) + ')'; ctx.lineWidth = Math.min(1.8, pr * 2.5); ctx.stroke(); ctx.restore(); }

        // L5: highlight
        if (pr > 0.015) { ctx.save(); ctx.beginPath(); ctx.rect(0, 0, pageW, pageH); ctx.clip(); clipF(f, false, cv); var hw = Math.min(25, pageW * pr * 0.12); var hg = ctx.createLinearGradient(f.mx - f.fnx, f.my - f.fny, f.mx - f.fnx * hw, f.my - f.fny * hw); hg.addColorStop(0, 'rgba(255,255,255,' + Math.min(0.14, pr * 0.18) + ')'); hg.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = hg; ctx.fillRect(-50, -50, pageW + 100, pageH + 100); ctx.restore(); }
    }

    // ═══════════════════════════════════════
    //  POINTER
    // ═══════════════════════════════════════
    function pos(e) {
        var r = canvas.getBoundingClientRect();
        var cx = e.touches ? e.touches[0].clientX : e.clientX;
        var cy = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: (cx - r.left) * (pageW / r.width), y: (cy - r.top) * (pageH / r.height) };
    }

    function onDown(e) {
        if (animating) return; initAudio();
        var p = pos(e), ez = pageW * 0.30;
        if (p.x > pageW - ez && curPage < total - 1) { dragging = true; flipDir = 1; corner = { x: pageW, y: p.y > pageH / 2 ? pageH : 0 }; pointer = p; canvas.style.cursor = 'grabbing'; draw(); return; }
        if (p.x < ez && curPage > 0) { dragging = true; flipDir = -1; corner = { x: 0, y: p.y > pageH / 2 ? pageH : 0 }; pointer = p; canvas.style.cursor = 'grabbing'; draw(); return; }
    }

    function onMove(e) {
        if (!dragging) { var p = pos(e), ez = pageW * 0.30; canvas.style.cursor = ((p.x > pageW - ez && curPage < total - 1) || (p.x < ez && curPage > 0)) ? 'grab' : 'default'; return; }
        e.preventDefault(); pointer = pos(e); draw();
    }

    function onUp() {
        if (!dragging) return; dragging = false; canvas.style.cursor = 'default';
        var cp = clamp(corner, pointer), f = fold(corner, cp);
        var diag = Math.sqrt(pageW * pageW + pageH * pageH);
        var pr = f ? Math.min(1, f.dist / diag) : 0;
        if (pr > 0.18) animComplete(); else animSnap();
    }

    // ═══════════════════════════════════════
    //  ANIMATIONS
    // ═══════════════════════════════════════
    function animComplete() {
        animating = true; var sx = pointer.x, sy = pointer.y;
        var tx = corner.x === pageW ? -pageW * 0.35 : pageW * 1.35, ty = corner.y;
        flipSound(); var t0 = performance.now(), dur = 480;
        (function step(now) {
            var t = Math.min((now - t0) / dur, 1), e = 1 - Math.pow(1 - t, 3);
            pointer = { x: sx + (tx - sx) * e, y: sy + (ty - sy) * e }; draw();
            if (t < 1) requestAnimationFrame(step);
            else { curPage += flipDir; animating = false; flipDir = 0; draw(); updateNav(); }
        })(performance.now());
    }

    function animSnap() {
        animating = true; var sx = pointer.x, sy = pointer.y, tx = corner.x, ty = corner.y;
        var t0 = performance.now(), dur = 320;
        (function step(now) {
            var t = Math.min((now - t0) / dur, 1);
            var e = Math.min(1, 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 0.3));
            pointer = { x: sx + (tx - sx) * e, y: sy + (ty - sy) * e }; draw();
            if (t < 1) requestAnimationFrame(step); else { animating = false; flipDir = 0; draw(); }
        })(performance.now());
    }

    function autoFlip(d) {
        if (animating || dragging) return;
        if (curPage + d < 0 || curPage + d >= total) return;
        initAudio(); flipDir = d;
        corner = { x: d === 1 ? pageW : 0, y: pageH };
        pointer = { x: d === 1 ? pageW - 3 : 3, y: pageH - 3 };
        animComplete();
    }

    function updateNav() {
        pageInd.textContent = (curPage + 1) + ' / ' + total;
        navL.classList.toggle('disabled', curPage <= 0);
        navR.classList.toggle('disabled', curPage >= total - 1);
    }

    var flipBound = false;
    function bindFlip() {
        if (flipBound) return; flipBound = true;
        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        canvas.addEventListener('touchstart', onDown, { passive: true });
        window.addEventListener('touchmove', onMove, { passive: false });
        window.addEventListener('touchend', onUp);
        navL.addEventListener('click', function () { autoFlip(-1); });
        navR.addEventListener('click', function () { autoFlip(1); });
        document.addEventListener('keydown', function (e) {
            if (flipCtr.classList.contains('hidden')) return;
            if (e.key === 'ArrowRight' || e.key === 'ArrowDown') autoFlip(1);
            else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') autoFlip(-1);
        });
        window.addEventListener('resize', function () { if (!flipCtr.classList.contains('hidden')) { calcSize(); draw(); } });
    }

    // ═══════════════════════════════════════
    //  INIT — check /view/:id
    // ═══════════════════════════════════════
    var m = window.location.pathname.match(/^\/view\/([a-f0-9]+)$/i);
    if (m) {
        uploadScreen.classList.add('hidden');
        shareBanner.classList.remove('hidden');
        shareUrl.value = window.location.origin + '/view/' + m[1];
        loadPDF('/api/pdf/' + m[1]);
    }

})();
