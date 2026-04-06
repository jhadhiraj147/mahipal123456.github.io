// ========================================================
// GLOBAL STATE
// ========================================================
let currentQuill = null;

let dbPromise = null;

let pageOrder = [];
let currentPageIndex = 0;

let notebookMeta = null;

const pageCache = new Map();
const MAX_CACHE_SIZE = 10;

const titleBox   = document.getElementById("top-margin");
const sideBox    = document.getElementById("left-margin-in");
const shadowPage = document.getElementById("shadow-effect");

const outputContainer = document.getElementById("output-container");

// ========================================================
// INDEXEDDB
// ========================================================
let idbScriptPromise = null;

function loadIDB() {
    // If already loaded, resolve immediately
    if (window.idb) return Promise.resolve();

    // If loading is already in progress, reuse it
    if (idbScriptPromise) return idbScriptPromise;

    idbScriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/idb/build/iife/index-min.js";
        script.async = true;

        script.onload = () => {
            if (window.idb) resolve();
            else reject(new Error("idb loaded but not available"));
        };

        script.onerror = () =>
            reject(new Error("Failed to load idb library"));

        document.head.appendChild(script);
    });

    return idbScriptPromise;
}

async function getDB() {
    if (dbPromise) return dbPromise;
        await loadIDB();

        
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("NotebookDB", 1);

        req.onupgradeneeded = (e) => {
            const db = e.target.result;

            if (!db.objectStoreNames.contains("pages")) {
                const store = db.createObjectStore("pages", {
                    keyPath: "id",
                    autoIncrement: true
                });
                store.createIndex("id", "id", { unique: true });
            }

            if (!db.objectStoreNames.contains("meta")) {
                db.createObjectStore("meta", { keyPath: "key" });
            }
        };

        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });

    return dbPromise;
}

async function getNotebookMeta() {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readonly");
        const store = tx.objectStore("meta");
        const req = store.get("notebook");

        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => reject(req.error);
    });
}

async function saveNotebookMeta() {
    const db = await getDB();
    notebookMeta = notebookMeta || { key: "notebook", pageOrder };
    notebookMeta.pageOrder = pageOrder;

    return new Promise((resolve, reject) => {
        const tx = db.transaction("meta", "readwrite");
        tx.objectStore("meta").put(notebookMeta).onsuccess = resolve;
        tx.onerror = reject;
    });
}

async function addPageToDB(page) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("pages", "readwrite");
        const req = tx.objectStore("pages").add(page);

        req.onsuccess = () => resolve(req.result);
        req.onerror   = () => reject(req.error);
    });
}

async function updatePageInDB(page) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("pages", "readwrite");
        tx.objectStore("pages").put(page).onsuccess = resolve;
        tx.onerror = reject;
    });
}

async function getPageFromDB(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("pages", "readonly");
        const req = tx.objectStore("pages").get(id);

        req.onsuccess = () => resolve(req.result || null);
        req.onerror   = () => reject(req.error);
    });
}

async function deletePageFromDB(id) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction("pages", "readwrite");
        tx.objectStore("pages").delete(id).onsuccess = resolve;
        tx.onerror = reject;
    });
}

// ========================================================
// CACHE (LRU)
// ========================================================
function cachePage(id, data) {
    if (pageCache.has(id)) pageCache.delete(id);
    pageCache.set(id, data);

    if (pageCache.size > MAX_CACHE_SIZE) {
        const old = pageCache.keys().next().value;
        pageCache.delete(old);
    }
}

function getCachedPage(id) {
    if (!pageCache.has(id)) return null;
    const data = pageCache.get(id);
    pageCache.delete(id);
    pageCache.set(id, data);
    return data;
}

// ========================================================
// NOTEBOOK INIT
// ========================================================
async function clearAllFromDB() {
    const db = await getDB();
    return new Promise((resolve) => {
        const tx = db.transaction(["meta", "pages"], "readwrite");
        tx.objectStore("meta").clear();
        tx.objectStore("pages").clear();
        tx.oncomplete = resolve;
    });
}
async function initNotebook() {
    // Explicit User Requirement: "when i refresh the page... it should be all vanished"
    await clearAllFromDB(); 

    notebookMeta = await getNotebookMeta();

    if (!notebookMeta) {
        const page = {
    title: "",
    side: "",
    quillDelta: null,
    quillHTML: "",
    images: []
};

        const id = await addPageToDB(page);
        pageOrder = [id];

        notebookMeta = { key: "notebook", pageOrder };
        await saveNotebookMeta();
    } else {
        pageOrder = notebookMeta.pageOrder || [];
        if (!pageOrder.length) {
           const page = {
    title: "",
    side: "",
    quillDelta: null,
    quillHTML: "",
    images: []
};

            const id = await addPageToDB(page);
            pageOrder = [id];
            notebookMeta.pageOrder = pageOrder;
            await saveNotebookMeta();
        }
    }

    currentPageIndex = 0;
}

// ========================================================
// DOM ↔ DATA
// ========================================================
function collectPageFromDOM(id) {
    return {
        id,
        title: titleBox.innerHTML,
        side: sideBox.innerHTML,

        // SOURCE OF TRUTH (editing)
        quillDelta: currentQuill?.getContents() || null,

        // DERIVED CACHE (export only)
        quillHTML: currentQuill?.root.innerHTML || "",

        images: [...shadowPage.querySelectorAll(".top-img")].map(img => ({
            src: img.src,
            style: img.style.cssText
        }))
    };
}

function updatePageIndicator() {
    const num = document.getElementById("pageNumber");
    if (!num) return;

    const total = Math.max(1, pageOrder.length);
    const current = Math.min(total, Math.max(1, currentPageIndex + 1));
    num.innerText = `${current}/${total}`;
}


function applyPageToDOM(data = {}) {
    titleBox.innerHTML = data.title || "";
    sideBox.innerHTML = data.side || "";

    // GUARD: block text-change from triggering pagination while loading
    window._isLoadingPage = true;
    if (currentQuill) {
        const safeDelta = data.quillDelta || { ops: [{ insert: "\n" }] };
        currentQuill.setContents(safeDelta, Quill.sources.SILENT);
    }
    // Small rAF delay ensures Quill finishes rendering before we release the guard
    requestAnimationFrame(() => {
        window._isLoadingPage = false;
    });

    shadowPage.querySelectorAll(".top-img").forEach(e => e.remove());
    (data.images || []).forEach(info => {
    const img = document.createElement("img");
    img.src = info.src;
    img.className = "top-img";
    img.style.cssText = info.style;

    img.dataset.x = img.dataset.x || 0;
    img.dataset.y = img.dataset.y || 0;
    if (!img.style.transform) img.style.transform = "translate(0px, 0px)";

    shadowPage.appendChild(img);
});

    if (data.images && data.images.length > 0) {
    loadInteract().then(() => {
        if (!window._interactInitialized) {
            initInteractForImages();
            window._interactInitialized = true;
        }
    });
}
    updatePageIndicator();
}

// ========================================================
// PAGE LOAD / SAVE
// ========================================================
async function loadPage(id) {
    const cached = getCachedPage(id);
    if (cached) return cached;

    const data = await getPageFromDB(id) || {
    id,
    title: "",
    side: "",
    quillDelta: null,
    quillHTML: "",
    images: []
};


    cachePage(id, data);
    return data;
}

async function saveCurrentPage() {
    if (!currentQuill || !pageOrder.length) return;
    if (currentPageIndex < 0 || currentPageIndex >= pageOrder.length) return;
    const id = pageOrder[currentPageIndex];
    const page = collectPageFromDOM(id);
    cachePage(id, page);
    await updatePageInDB(page);
}

// ========================================================
// SHOW PAGE
// ========================================================
async function showPage(i, { skipSave = false } = {}) {
    if (!pageOrder.length) return;
    if (!skipSave) await saveCurrentPage();

    const safeIndex = Math.max(0, Math.min(i, pageOrder.length - 1));
    currentPageIndex = safeIndex;
    const id = pageOrder[safeIndex];
    const data = await loadPage(id);
    applyPageToDOM(data);
}

// ========================================================
// CREATE / DELETE
// ========================================================
async function createNewPageInternal() {
    await saveCurrentPage();

    const defaultContent = {
        title: "",
        side: "",
        quillDelta: { ops: [{ insert: "\n" }] },
        quillHTML: "",
        images: []
    };

    const id = await addPageToDB(defaultContent);
    
    // Insert immediately after current page instead of at the very end
    pageOrder.splice(currentPageIndex + 1, 0, id);
    await saveNotebookMeta();

    cachePage(id, { id, ...defaultContent });

    currentPageIndex = currentPageIndex + 1;
    await showPage(currentPageIndex, { skipSave: true });
}

async function deleteCurrentPage() {
    const id = pageOrder[currentPageIndex];

    // CASE 1: Only one page → clear content instead of deleting
    if (pageOrder.length === 1) {
        const emptyPage = {
            id,
            title: "",
            side: "",
            quillDelta: { ops: [{ insert: "\n" }] },
            quillHTML: "",
            images: []
        };

        // Update cache + DB
        cachePage(id, emptyPage);
        await updatePageInDB(emptyPage);

        // Update UI
        applyPageToDOM(emptyPage);

        return;
    }

    // CASE 2: More than one page → real delete 
    await deletePageFromDB(id);
    pageCache.delete(id);

    pageOrder.splice(currentPageIndex, 1);
    await saveNotebookMeta();

    if (currentPageIndex >= pageOrder.length) {
        currentPageIndex = pageOrder.length - 1;
    }

    await showPage(currentPageIndex, { skipSave: true });
}

// ========================================================
// SCROLL-NAV
// ========================================================
function nextPage() {
    if (currentPageIndex + 1 < pageOrder.length) {
        showPage(currentPageIndex + 1);
    }
    // Do NOT auto-create a page on navigation — only autoPaginate does that
}

function prevPage() {
    if (currentPageIndex > 0) showPage(currentPageIndex - 1);
}

// ========================================================
// LAZY LOAD QUILL WHEN VIEWED
// ========================================================
function loadQuill() {
    return new Promise(resolve => {
        if (window.Quill && window.QuillTableBetter) {
            return resolve();
        }

        // Load Quill
        const quillJS = document.createElement("script");
        quillJS.src = "https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.js";

        quillJS.onload = () => {
            // Load table-better AFTER Quill
            const tableJS = document.createElement("script");
            tableJS.src = "https://cdn.jsdelivr.net/npm/quill-table-better@1.2.3/dist/quill-table-better.min.js";

            tableJS.onload = () => {

        // -------------------------------
        // Load KaTeX (LAST)
        // -------------------------------
        const katexJS = document.createElement("script");
        katexJS.src = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.js";

        katexJS.onload = resolve;
        document.head.appendChild(katexJS);

        const katexCSS = document.createElement("link");
        katexCSS.rel = "stylesheet";
        katexCSS.href = "https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css";
        document.head.appendChild(katexCSS);
      };

            document.head.appendChild(tableJS);

            const tableCSS = document.createElement("link");
            tableCSS.rel = "stylesheet";
            tableCSS.href = "https://cdn.jsdelivr.net/npm/quill-table-better@1.2.3/dist/quill-table-better.min.css";
            document.head.appendChild(tableCSS);
        };

        document.head.appendChild(quillJS);

        const quillCSS = document.createElement("link");
        quillCSS.rel = "stylesheet";
        quillCSS.href = "https://cdn.jsdelivr.net/npm/quill@2.0.3/dist/quill.snow.css";
        document.head.appendChild(quillCSS);
    });
}
// ========================================================
// RENDER SELECTED TEXT AS MATH (ONLY ON BUTTON CLICK)
// ========================================================
// ========================================================
// MATH EMBED (SELECTION → RENDER)
// ========================================================


async function renderSelectedMath(quill) {
    const range = quill.getSelection();
    if (!range || range.length === 0) return;

    let latex = quill.getText(range.index, range.length).trim();
    if (!latex) return;

    let display = false;

    if (latex.startsWith('$$') && latex.endsWith('$$')) {
        latex = latex.slice(2, -2).trim();
        display = true;
    } else if (latex.startsWith('\\[') && latex.endsWith('\\]')) {
        latex = latex.slice(2, -2).trim();
        display = true;
    } else if (latex.startsWith('\\(') && latex.endsWith('\\)')) {
        latex = latex.slice(2, -2).trim();
    } else if (latex.startsWith('$') && latex.endsWith('$')) {
        latex = latex.slice(1, -1).trim();
    }

    quill.deleteText(range.index, range.length, Quill.sources.USER);

    quill.insertEmbed(
        range.index,
        "math",
        { latex, display },
        Quill.sources.USER
    );

    quill.setSelection(range.index + 1, 0, Quill.sources.SILENT);
}

async function renderAllMath(quill) {
    const delta = quill.getContents();
    let text = "";
    if (delta && delta.ops) {
        for (const op of delta.ops) {
            if (typeof op.insert === 'string') {
                text += op.insert;
            } else {
                // For non-string inserts (e.g. math embeds), take exactly 1 string index
                text += '\uFFFC';
            }
        }
    }
    
    if (!text || !text.trim()) return;

    const ranges = [];

    const delimiters = [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false }
    ];

    function isEscaped(str, index) {
        let backslashes = 0;
        for (let i = index - 1; i >= 0 && str[i] === '\\'; i--) backslashes++;
        return backslashes % 2 === 1;
    }

    function findNextLeft(str, from) {
        let best = null;
        for (const d of delimiters) {
            let i = str.indexOf(d.left, from);
            while (i !== -1 && isEscaped(str, i)) {
                i = str.indexOf(d.left, i + 1);
            }
            if (i !== -1) {
                if (!best || i < best.index || (i === best.index && d.left.length > best.delim.left.length)) {
                    best = { index: i, delim: d };
                }
            }
        }
        return best;
    }

    function findRight(str, right, from) {
        let i = str.indexOf(right, from);
        while (i !== -1 && isEscaped(str, i)) {
            i = str.indexOf(right, i + 1);
        }
        return i;
    }

    let pos = 0;
    while (pos < text.length) {
        const leftHit = findNextLeft(text, pos);
        if (!leftHit) break;

        const start = leftHit.index;
        const contentStart = start + leftHit.delim.left.length;
        const endDelim = findRight(text, leftHit.delim.right, contentStart);

        if (endDelim === -1) {
            pos = contentStart;
            continue;
        }

        const contentEnd = endDelim;
        const latex = text.slice(contentStart, contentEnd).trim();
        if (latex) {
            ranges.push({
                start,
                end: endDelim + leftHit.delim.right.length,
                latex,
                display: leftHit.delim.display
            });
        }

        pos = endDelim + leftHit.delim.right.length;
    }

    if (!ranges.length) return;

    ranges.sort((a, b) => a.start - b.start);

    const validRanges = ranges.filter((r) => {
        try {
            katex.renderToString(r.latex, {
                displayMode: r.display,
                throwOnError: true
            });
            return true;
        } catch (_) {
            return false;
        }
    });

    if (!validRanges.length) return;

    // Replace from back to front so earlier indexes remain stable.
    for (let i = validRanges.length - 1; i >= 0; i--) {
        const r = validRanges[i];
        quill.deleteText(r.start, r.end - r.start, Quill.sources.USER);
        quill.insertEmbed(r.start, "math", { latex: r.latex, display: r.display }, Quill.sources.USER);
    }
}

function initQuill() {
    if (currentQuill) return;

    // Register table-better
    Quill.register(
        { "modules/table-better": QuillTableBetter },
        true
    );
    const Embed = Quill.import("blots/embed");

    class MathBlot extends Embed {
        static blotName = "math";
        static tagName = "span";
        static className = "ql-math";

        static create(value) {
            const node = super.create();
            node.setAttribute("data-latex", value.latex);
            node.setAttribute("data-display", value.display ? "block" : "inline");

            katex.render(value.latex, node, {
                displayMode: value.display,
                throwOnError: false
            });

            return node;
        }

        static value(node) {
            return {
                latex: node.getAttribute("data-latex"),
                display: node.getAttribute("data-display") === "block"
            };
        }
    }

    Quill.register(MathBlot);

    currentQuill = new Quill("#output-container", {
        modules: {
            table: false, // IMPORTANT: disable default table
             toolbar: {
            container: "#toolbar-container",
            handlers: {
                "render-math": function () {
                    renderSelectedMath(currentQuill);
                },
                "render-all-math": function () {
                    renderAllMath(currentQuill);
                }
            }
        },
            "table-better": {
                language: "en_US",
                menus: ["column", "row", "merge", "table", "cell", "wrap", "copy", "delete"],
                toolbarTable: true
            },
            keyboard: {
                bindings: {
                    ...QuillTableBetter.keyboardBindings,
                    pageBackspaceMerge: {
                        key: 'Backspace',
                        collapsed: true,
                        handler: function(range) {
                            if (!range || range.index !== 0 || currentPageIndex === 0) {
                                return true;
                            }
                            mergeCurrentPageIntoPrevious().catch((err) => {
                                console.error('Backspace merge failed:', err);
                            });
                            return false;
                        }
                    }
                }
            }
        },
        theme: "snow",
        placeholder: "Type or paste your content here"
    });

    currentQuill.root.id = "output-inner-container";

    // Defensive binding: ensure custom math buttons always trigger handlers.
    const renderBtn = document.querySelector('#toolbar-container .ql-render-math');
    if (renderBtn && !renderBtn.dataset.bound) {
        renderBtn.dataset.bound = '1';
        renderBtn.addEventListener('click', (e) => {
            e.preventDefault();
            renderSelectedMath(currentQuill);
        });
    }

    const renderAllBtn = document.querySelector('#toolbar-container .ql-render-all-math');
    if (renderAllBtn && !renderAllBtn.dataset.bound) {
        renderAllBtn.dataset.bound = '1';
        renderAllBtn.addEventListener('click', (e) => {
            e.preventDefault();
            renderAllMath(currentQuill);
        });
    }
    
    // Listen for text changes to trigger auto-pagination
    let paginationTimeout;
    currentQuill.on('text-change', (delta, oldDelta, source) => {
        // CRITICAL: never auto-paginate when we are loading page data into the editor
        if (window._isLoadingPage) return;
        if (source === 'user') {
            clearTimeout(paginationTimeout);
            paginationTimeout = setTimeout(() => {
                autoPaginate();
            }, 100);
        }
    });

    // Detect structural or font changes applied from controls!
    // This solves the bug where changing the handwriting style, font size, or 
    // container geometry caused silent desynchronization until the user pressed a key.
    const resizeObserver = new ResizeObserver(() => {
        if (window._isLoadingPage || isPaginating) return;
        clearTimeout(paginationTimeout);
        paginationTimeout = setTimeout(() => {
            autoPaginate();
        }, 150);
    });
    // Monitor both the specific paper and editor bounds
    resizeObserver.observe(currentQuill.root);

    // Also aggressively catch ANY external font, style, or class changes 
    // applied by the customization sliders and handwriting buttons!
    const styleObserver = new MutationObserver((mutations) => {
        if (window._isLoadingPage || isPaginating) return;
        let needsReflow = false;
        for (const mut of mutations) {
            if (mut.attributeName === 'style' || mut.attributeName === 'class') {
                needsReflow = true;
                break;
            }
        }
        if (needsReflow) {
            clearTimeout(paginationTimeout);
            paginationTimeout = setTimeout(() => {
                autoPaginate();
            }, 150);
        }
    });

    styleObserver.observe(currentQuill.root, { attributes: true, attributeFilter: ['style', 'class'] });
    const outputContainer = document.getElementById('output-container');
    if (outputContainer) {
        styleObserver.observe(outputContainer, { attributes: true, attributeFilter: ['style', 'class'] });
    }
}

// ========================================================
// TRUE WYSIWYG AUTO-PAGINATION
// ========================================================
let isPaginating = false;
let pendingRepaginate = false;

let sterileQuill = null;
let sterileContainer = null;

async function mergeCurrentPageIntoPrevious() {
    if (!currentQuill || currentPageIndex <= 0) return;

    const DeltaClass = Quill.import('delta');
    const currentId = pageOrder[currentPageIndex];
    const prevIndex = currentPageIndex - 1;
    const prevId = pageOrder[prevIndex];

    const currentData = collectPageFromDOM(currentId);
    cachePage(currentId, currentData);
    await updatePageInDB(currentData);

    const prevData = await loadPage(prevId);
    const prevDelta = new DeltaClass((prevData.quillDelta && prevData.quillDelta.ops) ? prevData.quillDelta.ops : []);
    const currDelta = new DeltaClass((currentData.quillDelta && currentData.quillDelta.ops) ? currentData.quillDelta.ops : []);

    let prevBody = prevDelta;
    if (prevDelta.length() > 0) {
        const lastOp = prevDelta.ops[prevDelta.ops.length - 1];
        if (typeof lastOp.insert === 'string' && lastOp.insert.endsWith('\n')) {
            prevBody = prevDelta.slice(0, prevDelta.length() - 1);
        }
    }
    
    const caretIndexInPrev = Math.max(0, prevBody.length());
    prevData.quillDelta = prevBody.concat(currDelta);
    cachePage(prevId, prevData);
    await updatePageInDB(prevData);

    currentData.quillDelta = new DeltaClass([{ insert: '\n' }]);
    cachePage(currentId, currentData);
    await updatePageInDB(currentData);

    await showPage(prevIndex, { skipSave: true });

    if (currentQuill) {
        const safeCaret = Math.min(caretIndexInPrev, Math.max(0, currentQuill.getLength() - 1));
        currentQuill.setSelection(safeCaret, 0, Quill.sources.SILENT);
    }

    setTimeout(() => {
        autoPaginate();
    }, 0);
}

function getSterileQuill() {
    if (!sterileQuill) {
        sterileContainer = document.createElement('div');
        sterileContainer.style.cssText = "position: absolute; top: -9999px; left: -9999px; visibility: hidden; pointer-events: none;";
        document.body.appendChild(sterileContainer);
        sterileQuill = new Quill(sterileContainer, { theme: 'snow', modules: { toolbar: false } });
    }
    
    // Explicitly mirror every typographic footprint of the live editor 
    // to ensure wrap geometries map perfectly natively natively.
    const realEditor = document.querySelector('#output-inner-container');
    if (!realEditor) return sterileQuill;
    
    const realStyles = window.getComputedStyle(realEditor);
    const cloneEditor = sterileQuill.root;
    
    const cssProps = [
        'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
        'line-height', 'letter-spacing', 'word-spacing', 'text-align'
    ];
    
    let clonedCSS = `
        width: ${realEditor.clientWidth}px !important;
        padding: 0px 10px !important;
        white-space: pre-line !important;
        overflow-wrap: anywhere !important;
        overflow: visible !important;
        height: auto !important;
        min-height: 0 !important;
    `;
    
    for (const prop of cssProps) {
        clonedCSS += `${prop}: ${realStyles.getPropertyValue(prop)} !important; `;
    }
    
    cloneEditor.style.cssText = clonedCSS;
    return sterileQuill;
}

function findPageSplitIndex(delta, paperContentHeight) {
    const sq = getSterileQuill();
    sq.setContents(delta, Quill.sources.SILENT);

    const totalLength = sq.getLength();
    
    // SAFETY REFACTOR: Handwriting fonts have massive "descenders" (the bottom tails 
    // of letters like 'p', 'y', 'g', 'j'). If we allow text to go exactly to the 
    // physical bottom pixel, the container's CSS margin or overflow will truncate 
    // the tail of the letter. 
    // Added a 25px bottom-buffer so the last line always breathes comfortably inside!
    const maxContentBottom = Math.max(1, paperContentHeight - 25);

    const fullBounds = sq.getBounds(Math.max(0, totalLength - 1));
    if (!fullBounds || fullBounds.bottom <= maxContentBottom) {
        return totalLength;
    }

    let low = 1;
    let high = totalLength;
    let fit = 0;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        
        let checkMid = mid;
        let bounds = sq.getBounds(checkMid);
        // If bounds is null (e.g. invisible trailing space or \n), fall back to previous character's bounds
        while (!bounds && checkMid > 0) {
            checkMid--;
            bounds = sq.getBounds(checkMid);
        }

        if (bounds && bounds.bottom <= maxContentBottom) {
            fit = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    let splitIndex = Math.max(1, fit + 1);

    // SMART SNAP LOGIC:
    // Only snap backward if we are splitting precisely in the middle of a word!
    // Never snap backward over user-typed spaces and newlines, which causes giant gaps
    // to be shoved to the next page.
    if (splitIndex < totalLength) {
        const charAtSplit = sq.getText(Math.max(0, splitIndex - 1), 2);
        if (charAtSplit.length === 2 && !charAtSplit.includes(' ') && !charAtSplit.includes('\n')) {
            const SNAP_WINDOW = 15;
            const start = Math.max(0, splitIndex - SNAP_WINDOW);
            const probe = sq.getText(start, SNAP_WINDOW);
            const lastSpace = probe.lastIndexOf(' ');
            const lastNewline = probe.lastIndexOf('\n');
            const bestBreak = Math.max(lastSpace, lastNewline);
            
            if (bestBreak !== -1) {
                splitIndex = start + bestBreak + 1;
            }
        }
    }

    return Math.max(1, Math.min(splitIndex, totalLength));
}

async function autoPaginate() {
    if (!currentQuill || !pageOrder.length) return;
    if (isPaginating) {
        pendingRepaginate = true;
        return;
    }
    
    const editorNode = currentQuill.root;
    const outputContainer = document.getElementById('output-container');
    if (!outputContainer) return;
    
    const PAPER_CONTENT_HEIGHT = outputContainer.clientHeight;

    isPaginating = true;
    window._isLoadingPage = true;

    try {
        const safeStartIndex = Math.max(0, Math.min(currentPageIndex, pageOrder.length - 1));
        const affectedPageIds = pageOrder.slice(safeStartIndex);
        
        // 1. PRELOAD ASYNC DB STATES
        const loadedPagesMap = {};
        for (const id of affectedPageIds) {
            loadedPagesMap[id] = await loadPage(id);
        }
        const templatePage = loadedPagesMap[affectedPageIds[0]];
        
        // --- SYNCHRONOUS CRITICAL SECTION START ---
        // Nothing inside this block yields the event loop!
        const originalPageIndex = currentPageIndex;
        const originalSelection = currentQuill.getSelection();
        const wasFocused = currentQuill.hasFocus();
        const scrollContainer = document.getElementById('outer-container');
        const originalScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
        
        const DeltaClass = Quill.import('delta');
        const liveDelta = currentQuill.getContents();
        let combinedDelta = new DeltaClass();

        for (let i = 0; i < affectedPageIds.length; i++) {
            const pageId = affectedPageIds[i];
            let pageDelta;

            if (pageId === pageOrder[currentPageIndex]) {
                // Determine if the original stored page intentionally ended with a newline
                const storedDelta = loadedPagesMap[pageId]?.quillDelta;
                const sd = new DeltaClass((storedDelta && storedDelta.ops) ? storedDelta.ops : []);
                
                let storedEndsWithNewline = false;
                if (sd.length() > 0) {
                    const lastOp = sd.ops[sd.ops.length - 1];
                    if (typeof lastOp.insert === 'string' && lastOp.insert.endsWith('\n')) {
                        // The user's page explicitly possessed a trailing newline.
                        storedEndsWithNewline = true;
                    }
                }

                const normalized = new DeltaClass(
                    (liveDelta && liveDelta.ops) ? liveDelta.ops : [{ insert: '\n' }]
                );
                
                if (!storedEndsWithNewline) {
                    // Quill adds a phantom newline if there wasn't one. Strip it!
                    pageDelta = normalized.length() > 1
                        ? normalized.slice(0, normalized.length() - 1)
                        : new DeltaClass();
                } else {
                    // Valid trailing newline existed. Keep Quill's newline intact.
                    pageDelta = normalized;
                }
            } else {
                // Inactive pages from DB are perfectly mathematical slices. DO NOT STRIP.
                const storedDelta = loadedPagesMap[pageId].quillDelta;
                pageDelta = new DeltaClass(
                    (storedDelta && storedDelta.ops) ? storedDelta.ops : []
                );
            }
            
            combinedDelta = combinedDelta.concat(pageDelta);
        }
        
        let combinedEndsWithNewline = false;
        if (combinedDelta.length() > 0) {
            const lastOp = combinedDelta.ops[combinedDelta.ops.length - 1];
            if (typeof lastOp.insert === 'string' && lastOp.insert.endsWith('\n')) {
                combinedEndsWithNewline = true;
            }
        }
        if (!combinedEndsWithNewline) {
            combinedDelta = combinedDelta.concat(new DeltaClass([{ insert: '\n' }]));
        }

        let remaining = combinedDelta;
        const reflowed = [];

        while (reflowed.length < affectedPageIds.length) {
            if (remaining.length() === 0) {
                reflowed.push(new DeltaClass([{ insert: '\n' }]));
                continue;
            }

            const splitIndex = findPageSplitIndex(remaining, PAPER_CONTENT_HEIGHT);
            const clamped = Math.max(1, Math.min(splitIndex, remaining.length()));

            reflowed.push(remaining.slice(0, clamped));
            remaining = remaining.slice(clamped);
        }

        const newPagesPending = [];
        while (remaining.length() > 0) {
            if (remaining.length() === 1) {
                const singleOp = remaining.ops[0];
                // Only drop if it's the exact phantom trailing text newline. 
                // Do NOT drop embeds (like Math formulas of length 1) or characters like "A"!
                if (typeof singleOp.insert === 'string' && singleOp.insert === '\n') {
                    break;
                }
            }
            const splitIndex = findPageSplitIndex(remaining, PAPER_CONTENT_HEIGHT);
            const clamped = Math.max(1, Math.min(splitIndex, remaining.length()));
            newPagesPending.push(remaining.slice(0, clamped));
            remaining = remaining.slice(clamped);
        }
        
        // Immediately restore the live DOM! This blocks all user edits cleanly.
        let restoreDelta = reflowed[currentPageIndex - safeStartIndex];
        if (!restoreDelta) {
            restoreDelta = new DeltaClass([{ insert: '\n' }]);
        }
        
        currentQuill.setContents(restoreDelta, Quill.sources.SILENT);

        if (wasFocused) {
            const targetIndex = Math.min(
                originalSelection?.index ?? 0,
                Math.max(0, currentQuill.getLength() - 1)
            );
            currentQuill.focus();
            currentQuill.setSelection(targetIndex, 0, Quill.sources.SILENT);
        }
        
        if (scrollContainer) {
            scrollContainer.scrollTop = originalScrollTop;
        }
        // --- SYNCHRONOUS CRITICAL SECTION END ---

        // 2. NOW RUN ALL ASYNC DB SAVES
        // Even if user types right now, it's fine! It will just trigger another autoPaginate.
        let addedPages = false;
        for (let i = 0; i < newPagesPending.length; i++) {
            const newPageData = {
                title: templatePage.title || '',
                side: templatePage.side || '',
                quillDelta: newPagesPending[i],
                quillHTML: '',
                images: []
            };

            const newId = await addPageToDB(newPageData);
            pageOrder.push(newId);
            addedPages = true;
            cachePage(newId, { id: newId, ...newPageData });
        }

        if (addedPages) {
            await saveNotebookMeta();
        }

        for (let i = 0; i < affectedPageIds.length; i++) {
            const pageId = affectedPageIds[i];
            const pageData = loadedPagesMap[pageId];
            pageData.quillDelta = reflowed[i];
            cachePage(pageId, pageData);
            await updatePageInDB(pageData);
        }

        // 3. COLLAPSE EMPTY PAGES
        const removableIds = [];
        for (let i = pageOrder.length - 1; i >= 1; i--) {
            const pageId = pageOrder[i];
            const pageData = await loadPage(pageId);
            const delta = pageData?.quillDelta;
            
            let isEmpty = false;
            if (!delta) {
                isEmpty = true;
            } else {
                const sd = (typeof delta.length === 'function') 
                    ? delta 
                    : new DeltaClass((delta.ops && Array.isArray(delta.ops)) ? delta.ops : []);
                const len = sd.length();
                if (len === 0) {
                    isEmpty = true;
                } else if (len === 1) {
                    const firstOp = sd.ops[0];
                    if (typeof firstOp.insert === 'string' && firstOp.insert === '\n') {
                        isEmpty = true;
                    }
                }
            }

            const hasImages = Array.isArray(pageData?.images) && pageData.images.length > 0;

            if (isEmpty && !hasImages) {
                removableIds.push(pageId);
            } else {
                break;
            }
        }

        if (removableIds.length > 0) {
            for (const id of removableIds) {
                await deletePageFromDB(id);
                pageCache.delete(id);
            }
            pageOrder = pageOrder.slice(0, pageOrder.length - removableIds.length);
            await saveNotebookMeta();
        }

        if (currentPageIndex >= pageOrder.length) {
            currentPageIndex = Math.max(0, pageOrder.length - 1);
            await showPage(currentPageIndex, { skipSave: true });
        } else {
            updatePageIndicator();
        }
        
    } catch(err) {
        console.error('Auto-Pagination Virtual Ripple Failed:', err);
    } finally {
        isPaginating = false;
        window._isLoadingPage = false;
        
        if (pendingRepaginate) {
            pendingRepaginate = false;
            setTimeout(() => {
                autoPaginate();
            }, 0);
        }
    }
}

// ========================================================
// INTERSECTION OBSERVER FOR LAZY LOAD
// ========================================================
function setupLazyLoad() {
    const observer = new IntersectionObserver(async (entries, obs) => {
        if (entries[0].isIntersecting) {
            await loadQuill();
            initQuill();
            await initNotebook();
            await showPage(0, { skipSave: true });

            obs.disconnect(); // load only once
        }
    });

    observer.observe(outputContainer);
}

document.addEventListener("DOMContentLoaded", setupLazyLoad);


window.onload = function () {
    let consent = localStorage.getItem("cookie_consent");

    if (consent === "granted") {
        enableGA4(); // Load GA4 if already accepted
        loadClarity();
        hideCookieBanner();
    } else if (consent === "denied") {
        hideCookieBanner();
    } else {
        setTimeout(function () {
            showCookieBanner();
        }, 5000); // Show banner after 5 seconds
    }

   
};

// Helper functions for cookie banner animations
function showCookieBanner() {
    const banner = document.getElementById("consentx-banner");
    if(banner) {
        banner.style.display = "block";
        // Force reflow to ensure the display change takes effect
        banner.offsetHeight;
    }
}

function hideCookieBanner() {
    const banner = document.getElementById("consentx-banner");
        banner.style.display = "none";
        // Match the CSS transition duration
}

// Accept Cookies and Enable GA4
function acceptConsentX() {
    localStorage.setItem("cookie_consent", "granted");

    gtag('consent', 'update', {
        'ad_storage': 'granted',
        'analytics_storage': 'granted',
        'ad_user_data': 'granted',
        'ad_personalization': 'granted'
    });

    gtag('config', 'G-Z44LLFS6JF'); // Now track page views
    loadClarity();

    hideCookieBanner();
    console.log("Cookies accepted, GA4 tracking enabled.");
}

// Deny Cookies and Disable Tracking
function denyConsentX() {
    localStorage.setItem("cookie_consent", "denied");

    gtag('consent', 'update', {
        'ad_storage': 'denied',
        'analytics_storage': 'denied',
        'ad_user_data': 'denied',
        'ad_personalization': 'denied'
    });

    hideCookieBanner();
    document.getElementById("manage-cookies").style.display = "block"; // Show manage button
    console.log("Cookies denied, GA4 tracking disabled.");
}

// Reopen Cookie Banner for Consent Management
function manageCookies() {
    showCookieBanner();
}
function loadClarity() {
    if (!window.clarity) { // Prevent multiple loads
        (function(c,l,a,r,i,t,y){
            c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};
            t=l.createElement(r); t.async=1; t.src="https://www.clarity.ms/tag/"+i;
            y=l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t,y);
        })(window, document, "clarity", "script", "utwyyh3a1v");
    }
}
// Enable GA4 if user has already accepted cookies
function enableGA4() {
    gtag('consent', 'update', {
        'ad_storage': 'granted',
        'analytics_storage': 'granted',
        'ad_user_data': 'granted',
        'ad_personalization': 'granted'
    });

    gtag('config', 'G-Z44LLFS6JF'); // Start tracking
    console.log("GA4 Consent Granted and Initialized");
}



function setLeftMarginHeight() {
    const leftmarginin = document.getElementById("left-margin-in");
    const outputContainer = document.getElementById("output-container");
    const leftMargin = document.getElementById("left-margin");

    const outputHeight = outputContainer.scrollHeight;

    // Set the height of the left margin container to match the output container height
    leftMargin.style.height = outputHeight + "px";
}
// Observer for output-container
const outputResizeObserver = new ResizeObserver(() => {
    setLeftMarginHeight(); // Only updates left margin when output-container resizes
});
outputResizeObserver.observe(document.getElementById('output-container'));

window.addEventListener('resize',  setLeftMarginHeight);


function toggleMobileMenu() {
    const navMenu = document.querySelector('.nav-menu');
    const toggleButton = document.querySelector('.mobile-menu-toggle');
    
    // Toggle the active class on the hamburger button for animation
    toggleButton.classList.toggle('active');
    
    // Toggle the mobile menu visibility
    navMenu.classList.toggle('active');
}
  // Define a function to change CSS properties
        function changeCSSProperty(property, value, elementIds) {
            elementIds.forEach(id => {
                const element = document.getElementById(id);
                if (element) {
                    element.style[property] = value;
                }
            });
        }

        // Utility function to set CSS variable values
function setCSSVariable(variable, value) {
    document.documentElement.style.setProperty(`--${variable}`, value);
  }
  window.addEventListener('DOMContentLoaded', () => {
    const cssVars = [
      { id: 'font-size-input', var: '--font-size', unit: 'px' },
      { id: 'top-margin-font-size-input', var: '--top-margin-font-size', unit: 'px' },
      { id: 'letter-spacing-input', var: '--letter-spacing', unit: 'px' },
      { id: 'word-spacing-input', var: '--word-spacing', unit: 'px' },
      { id: 'margin-top-input', var: '--margin-top', unit: 'px' },
      { id: 'margin-left-input', var: '--margin-left', unit: 'px' },
      { id: 'line-spacing-text-input', var: '--line-height', unit: 'px' },
      { id: 'line-spacing-input', var: '--line-spacing', unit: 'px' },
      { id: 'height-input', var: '--box-height', unit: '%' },
      { id: 'width-input', var: '--box-width', unit: '%' }
    ];
  
    const rootStyles = getComputedStyle(document.documentElement);
  
    cssVars.forEach(({ id, var: cssVar, unit }) => {
      const input = document.getElementById(id);
      const span = document.getElementById(id + '-value');
  
      if (input) {
        let value = rootStyles.getPropertyValue(cssVar).trim();
        if (value.endsWith(unit)) {
          value = value.replace(unit, '');
        }
        input.value = value;
        if (span) span.textContent = value;
      }
    });
  
    // Set color input value if applicable
    const fontColorInput = document.getElementById('font-color-input');
    const fontColor = rootStyles.getPropertyValue('--font-color').trim();
    if (fontColorInput && fontColor) {
      fontColorInput.value = fontColor;
    }
  });
  
  // Add event listeners to the inputs dynamically
  document.addEventListener('input', function(event) {
    const target = event.target;
  
    // Show the value beside the slider (if a span exists with ID pattern like 'xyz-value')
    const valueDisplay = document.getElementById(target.id + '-value');
    if (valueDisplay) {
      valueDisplay.textContent = target.value;
    }
  
    // Set corresponding CSS variables as before
    if (target.matches('#font-size-input')) {
      setCSSVariable('font-size', target.value + 'px');
    } else if (target.matches('#font-color-input')) {
      setCSSVariable('font-color', target.value);
    } else if (target.matches('#letter-spacing-input')) {
      setCSSVariable('letter-spacing', target.value + 'px');
    } else if (target.matches('#word-spacing-input')) {
      setCSSVariable('word-spacing', target.value + 'px');
    } else if (target.matches('#background-color-input')) {
      setCSSVariable('background-color', target.value);
    } else if (target.matches('#margin-top-input')) {
      setCSSVariable('margin-top', target.value + 'px');
    } else if (target.matches('#margin-left-input')) {
      setCSSVariable('margin-left', target.value + 'px');
    } else if (target.matches('#line-spacing-text-input')) {
      setCSSVariable('line-height', target.value + 'px');
    } else if (target.matches('#line-spacing-input')) {
      setCSSVariable('line-spacing', target.value + 'px');
    } else if (target.matches('#height-input')) {
      setCSSVariable('box-height', target.value + '%');
    } else if (target.matches('#width-input')) {
      setCSSVariable('box-width', target.value + '%');
    } else if (target.matches('#top-margin-font-size-input')) {
      setCSSVariable('top-margin-font-size', target.value + 'px');
    }
  });
  
  
                
        // Toggle left margin
        let leftMarginOn = true;
        let topMarginOn = true;
        function toggleLeftMargin() {
           
                leftMarginOn = !leftMarginOn;
           
        
            // Update the CSS variable using the helper function
            setCSSVariable('left-margin-display', leftMarginOn ? 'block' : 'none');
        }
        // Initial states


        // Toggle top margin
        function toggleTopMargin() {
            
                topMarginOn = !topMarginOn;
            
        
            // Update the CSS variable for top margin display
            setCSSVariable('top-margin-display', topMarginOn ? 'flex' : 'none');
        }


        let isLeftBorderOn = true;
        let isTopBorderOn = true;
        // Toggle left border
        function toggleLeftBorder() {
           
                isLeftBorderOn = !isLeftBorderOn;
            
        
            const leftBorderStyle = isLeftBorderOn ? '2px solid #00000066' : 'none';
        
            setCSSVariable('output-left-border', leftBorderStyle);
            setCSSVariable('top-margin-left-border', leftBorderStyle);
        }
        
        // Toggle top border
        function toggleTopBorder() {
          
                isTopBorderOn = !isTopBorderOn;
            
    
            const topBorderStyle = isTopBorderOn ? '1px solid #00000066' : 'none';
        
            setCSSVariable('top-margin-bottom-border', topBorderStyle);
            setCSSVariable('subbox-bottom-border', topBorderStyle);
        }
        
        



        // Listen for Page Format changes
        document.getElementById('page-size-select')?.addEventListener('change', (e) => {
            let ratio = 0.707; // A4 (1 / 1.414)
            if (e.target.value === 'letter') ratio = 0.772; // US Letter (8.5 / 11)
            if (e.target.value === 'foolscap') ratio = 0.615; // Legal (8 / 13)
            
            setCSSVariable('page-aspect-ratio', ratio);
            
            // Re-calc flow if sizes shrink
            setTimeout(autoPaginate, 800);
        });

        // Workspace Zoom — applies CSS zoom to the paper itself
        // CSS zoom (unlike transform:scale) DOES affect layout, so scroll works correctly
        const wsZoomSlider = document.getElementById('workspace-zoom');
        const wsZoomVal = document.getElementById('workspace-zoom-val');
        // Store current zoom for pagination to reference
        window._currentPaperZoom = 1.0;

        function applyWorkspaceZoom(ratio) {
            const paper = document.getElementById('final_page');
            if (!paper) return;
            window._currentPaperZoom = ratio;
            // CSS zoom changes the element's layout dimensions proportionally
            // At zoom:0.7, a 794x1123 paper becomes 556x786 in the layout
            paper.style.zoom = ratio;
            if (wsZoomVal) wsZoomVal.textContent = Math.round(ratio * 100) + '%';
        }

        if (wsZoomSlider && wsZoomVal) {
            wsZoomSlider.addEventListener('input', (e) => {
                applyWorkspaceZoom(parseFloat(e.target.value));
            });
        }

        // Auto-fit: shrink paper so the ENTIRE page (both W and H) fits in the viewport
        function autoFitToScreen() {
            if (!wsZoomSlider || !wsZoomVal) return;
            const container = document.getElementById('outer-container');
            if (!container) return;

            const A4_W = 794;
            const A4_H = 1123;
            // Available space in the scrollable viewport (subtract padding)
            const availW = container.clientWidth  - 48;
            const availH = container.clientHeight - 60;

            const ratioW = availW / A4_W;
            const ratioH = availH / A4_H;
            let ratio = Math.min(ratioW, ratioH);
            ratio = Math.max(0.25, Math.min(1.5, ratio));

            wsZoomSlider.value = ratio;
            applyWorkspaceZoom(ratio);
        }

        window.addEventListener('resize', autoFitToScreen);
        setTimeout(autoFitToScreen, 300);

        // Sidebar/Container resize observer
        const containerElem = document.getElementById('outer-container');
        if (containerElem) {
            new ResizeObserver(() => autoFitToScreen()).observe(containerElem);
        }

        // Run once the DOM has settled
        setTimeout(autoFitToScreen, 150);

        // Toggle background image
        let isBackgroundOn = false;  // matches CSS default (--background-lines: none)

        function toggleBackground() {
            const checkbox = document.getElementById('bg-toggle');
            isBackgroundOn = checkbox.checked;   // read directly — no toggle drift

            const backgroundValue = isBackgroundOn
                ? 'linear-gradient(#0c1d8c66 1px, transparent 1px)'
                : 'none';

            setCSSVariable('background-lines', backgroundValue);
        }

        
        
        


        function changeBackgroundImage() {
            var input = document.getElementById('background-image-input');
            var file = input.files[0];
            var reader = new FileReader();
        
            document.getElementById('remove-button').style.display = 'block';
        
            reader.onload = function(e) {
                var backgroundImage = e.target.result;
                setCSSVariable('custom-background-image', `url('${backgroundImage}')`);
            };
        
            reader.readAsDataURL(file);
        }
        
        function removeBackgroundImage() {
            // Reset the CSS variable to 'none' instead of setting background-image directly
            setCSSVariable('custom-background-image', '');
            
            document.getElementById('background-image-input').value = ''; // Clear the file input
            document.getElementById('remove-button').style.display = 'none'; // Hide the remove button
        }
        
   

        let customFontUploaded = false;
        let uploadedFontFamily = '';
        
        // Core: update both main- and math-font variables
        function applyFontVariables(fontFamily) {
          // Build the stack: Uploaded/fontFamily, then CustomFont, then KaTeX_Main
          const stack = `${fontFamily}, CustomFont, KaTeX_Main`;
          setCSSVariable('main-font', stack);
        
          // Math toggles to either CustomFont stack or use same stack
          const useDefaultMath = document.getElementById('default-math-font-checkbox').checked;
          setCSSVariable('math-font', useDefaultMath
            ? `CustomFont, KaTeX_Main`
            : stack
          );
        }
        
        // Call when dropdown changes
        function changeFontFamily() {
          const select = document.getElementById('font-family-select');
          const font = select.value;
          customFontUploaded = false;        
          uploadedFontFamily = '';
          document.getElementById('font-file-input').value = ''; 
          applyFontVariables(font);
        }
        
        // Call when uploading a font file
        function changeFontfile(elementId, fontFamily) {
            const fileInput = document.getElementById('font-file-input');
            if (!fileInput.files[0]) {
                alert('Please upload a font file first.');
                return;
            }
        
            const reader = new FileReader();
            reader.onload = function(e) {
                // Convert ArrayBuffer to Base64 for CSS @font-face
                const fontData = e.target.result;
                const base64FontData = arrayBufferToBase64(fontData);
        
                // Create the @font-face rule
                const fontFaceRule = `
                    @font-face {
                        font-family: '${fontFamily}';
                        src: url(data:font/truetype;base64,${base64FontData}) format('truetype');
                    }
                `;
        
                // Remove previous custom font-face rule if any
                if (window.customFontStyle) {
                    window.customFontStyle.remove();
                }
        
                // Create a new style element to inject @font-face rule
                const style = document.createElement('style');
                style.innerHTML = fontFaceRule;
                document.head.appendChild(style);
                window.customFontStyle = style; 
        
            // Now treat this as the custom font
            customFontUploaded = true;
            uploadedFontFamily = fontFamily;
            applyFontVariables(fontFamily);
            input.value = '';
          };
          reader.readAsArrayBuffer(fileInput.files[0]);
                }
                function arrayBufferToBase64(buffer) {
                    var binary = '';
                    var bytes = new Uint8Array(buffer);
                    var len = bytes.byteLength;
                    for (var i = 0; i < len; i++) {
                        binary += String.fromCharCode(bytes[i]);
                    }
                    return window.btoa(binary);
                }
                
        
        // Call when math-font checkbox toggles
        function toggleMathFont() {
          // Pick whichever font is active (uploaded or dropdown)
          const select = document.getElementById('font-family-select');
          const baseFont = customFontUploaded ? uploadedFontFamily : select.value;
          applyFontVariables(baseFont);
        }
   (function () {
  const picker = document.getElementById("fontPicker");
  const select = document.getElementById("font-family-select");

  // ==============================
  // DEFAULT FONT ON PAGE LOAD
  // ==============================
  const defaultFont = picker.querySelector(".font-option.active") || picker.querySelector(".font-option");

  if (defaultFont) {
    select.value = defaultFont.dataset.font;
    changeFontFamily(); // APPLY DEFAULT FONT
  }

  // ==============================
  // CLICK HANDLER
  // ==============================
  picker.addEventListener("click", (e) => {
    const option = e.target.closest(".font-option");
    if (!option) return;

    picker.querySelectorAll(".font-option")
      .forEach(o => o.classList.remove("active"));

    option.classList.add("active");
    select.value = option.dataset.font;
    changeFontFamily();
  });
})();
(function () {
  const options = document.querySelectorAll(".font-option");

  const observer = new IntersectionObserver(
    (entries, obs) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;

        const el = entry.target;

        // Apply font ONLY ONCE
        el.style.fontFamily = el.dataset.font;

        // Stop observing after first load
        obs.unobserve(el);
      });
    },
    {
      root: null,        // viewport
      rootMargin: "0px",
      threshold: 0.1     // 10% visible
    }
  );

  options.forEach(el => observer.observe(el));
})();

document.addEventListener('DOMContentLoaded', changeFontFamily);

// ========================================================
// SCRIPT LOADER
// ========================================================
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve(); // Already loaded
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.body.appendChild(script);
  });
}

// ========================================================
// =====================================================================
//  GLOBAL HANDWRITING SETTINGS
// =====================================================================
const HW = {
    enabled: true,

    // ======================
    // LINE LEVEL
    // ======================
    lineSlopeEnabled: true,
    lineSlopeMax: 2,

    lineSpacingNoiseEnabled: true,
    lineSpacingNoiseMax: 3,

    lineFontNoiseEnabled: true,
    lineFontNoiseMax: 2, // %

    // ======================
    // WORD LEVEL
    // ======================
    wordBaselineEnabled: true,
    wordBaselineMax: 2,

    wordRotationEnabled: true,
    wordRotationMax: 3,

    wordSpacingNoiseEnabled: true,
    wordSpacingNoiseMax: 3,

letterSpacingNoiseEnabled: true,
letterSpacingNoiseMax: 0.6, // px
    // ======================
    // INK & PAPER
    // ======================
    inkBlurEnabled: true,
    inkBlurAmount: 0.3,

    inkFlowEnabled: true,
    inkFlowAmount: 0.9,

    inkShadowEnabled: true,
    inkShadowAmount: 1,

    paperTextureEnabled: true,
    paperTextureStrength: 0.18,

    paperShadowEnabled: true,
    paperShadowStrength: 0.35
};
function updateHandwritingSettings() {

    HW.enabled = document.getElementById("toggle-handwriting").checked;

    // -------- LINE LEVEL --------
    HW.lineSlopeEnabled =
        document.getElementById("toggle-line-slope").checked;
    HW.lineSlopeMax =
        parseFloat(document.getElementById("line-slope-input").value);

    HW.lineSpacingNoiseEnabled =
        document.getElementById("toggle-line-spacing-noise").checked;
    HW.lineSpacingNoiseMax =
        parseFloat(document.getElementById("line-spacing-noise-input").value);

    HW.lineFontNoiseEnabled =
        document.getElementById("toggle-line-font-noise").checked;
    HW.lineFontNoiseMax =
        parseFloat(document.getElementById("line-font-noise-input").value);

    // -------- WORD LEVEL --------
    HW.wordBaselineEnabled =
        document.getElementById("toggle-word-baseline").checked;
    HW.wordBaselineMax =
        parseFloat(document.getElementById("word-baseline-input").value);

    HW.wordRotationEnabled =
        document.getElementById("toggle-word-rotation").checked;
    HW.wordRotationMax =
        parseFloat(document.getElementById("word-rotation-input").value);

    HW.wordSpacingNoiseEnabled =
        document.getElementById("toggle-word-spacing-noise").checked;
    HW.wordSpacingNoiseMax =
        parseFloat(document.getElementById("word-spacing-noise-input").value);

        HW.letterSpacingNoiseEnabled =
    document.getElementById("toggle-letter-spacing-noise").checked;

HW.letterSpacingNoiseMax =
    parseFloat(document.getElementById("letter-spacing-noise-input").value);

    // -------- INK & PAPER --------
    HW.inkBlurEnabled =
        document.getElementById("toggle-ink-blur").checked;
    HW.inkBlurAmount =
        parseFloat(document.getElementById("ink-blur-input").value);

    HW.inkFlowEnabled =
        document.getElementById("toggle-ink-flow").checked;
    HW.inkFlowAmount =
        parseFloat(document.getElementById("ink-flow-input").value);

    HW.inkShadowEnabled =
        document.getElementById("toggle-ink-shadow").checked;
    HW.inkShadowAmount =
        parseFloat(document.getElementById("ink-shadow-input").value);

    HW.paperTextureEnabled =
        document.getElementById("toggle-paper-texture").checked;
    HW.paperTextureStrength =
        parseFloat(document.getElementById("paper-texture-input").value);

    HW.paperShadowEnabled =
        document.getElementById("toggle-paper-shadow").checked;
    HW.paperShadowStrength =
        parseFloat(document.getElementById("paper-shadow-input").value);
}
function updateHandwritingUI() {

    // LINE LEVEL
    document.getElementById("line-slope-value").innerText =
        document.getElementById("line-slope-input").value + "°";

    document.getElementById("line-spacing-noise-value").innerText =
        document.getElementById("line-spacing-noise-input").value + "px";

    document.getElementById("line-font-noise-value").innerText =
        document.getElementById("line-font-noise-input").value + "%";

    // WORD LEVEL
    document.getElementById("word-baseline-value").innerText =
        document.getElementById("word-baseline-input").value + "px";

    document.getElementById("word-rotation-value").innerText =
        document.getElementById("word-rotation-input").value + "°";

    document.getElementById("word-spacing-noise-value").innerText =
        document.getElementById("word-spacing-noise-input").value + "px";

    document.getElementById("letter-spacing-noise-value").innerText =
    document.getElementById("letter-spacing-noise-input").value + "px";


    // INK & PAPER
    document.getElementById("ink-blur-value").innerText =
        document.getElementById("ink-blur-input").value + "px";

    document.getElementById("ink-flow-value").innerText =
        document.getElementById("ink-flow-input").value;

    document.getElementById("ink-shadow-value").innerText =
        document.getElementById("ink-shadow-input").value + "px";

    document.getElementById("paper-texture-value").innerText =
        document.getElementById("paper-texture-input").value;

    document.getElementById("paper-shadow-value").innerText =
        document.getElementById("paper-shadow-input").value;
}
function initHandwritingControls() {

    const controls = document.querySelectorAll(`
        #toggle-handwriting,

        #toggle-line-slope, #line-slope-input,
        #toggle-line-spacing-noise, #line-spacing-noise-input,
        #toggle-line-font-noise, #line-font-noise-input,

        #toggle-word-baseline, #word-baseline-input,
        #toggle-word-rotation, #word-rotation-input,
        #toggle-word-spacing-noise, #word-spacing-noise-input,

        #toggle-ink-blur, #ink-blur-input,
        #toggle-ink-flow, #ink-flow-input,
        #toggle-ink-shadow, #ink-shadow-input,

        #toggle-paper-texture, #paper-texture-input,
        #toggle-paper-shadow, #paper-shadow-input,
        #toggle-letter-spacing-noise, #letter-spacing-noise-input

    `);

    controls.forEach(el => {
        el.addEventListener("input", () => {
            updateHandwritingSettings();
            updateHandwritingUI();
        });
        el.addEventListener("change", () => {
            updateHandwritingSettings();
            updateHandwritingUI();
        });
    });

    updateHandwritingSettings();
    updateHandwritingUI();
}

document.addEventListener("DOMContentLoaded", initHandwritingControls);

// =====================================================================
//  APPLY HANDWRITING EFFECT (WORD + CHARACTER + INK EFFECTS)
// =====================================================================
// ============================================================
//  FAST 4× OPTIMIZED HANDWRITING EFFECT
// ============================================================

let PAPER_TEXTURE_URL = null;

function getPaperTexture(opacity) {
  if (PAPER_TEXTURE_URL) return PAPER_TEXTURE_URL;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
      <defs>
        <filter id="paper">
          <feTurbulence type="fractalNoise" baseFrequency="0.15" numOctaves="5"/>
          <feColorMatrix type="saturate" values="0"/>
          <feComponentTransfer>
            <feFuncA type="linear" slope="${opacity}"/>
          </feComponentTransfer>
        </filter>
      </defs>
      <rect width="100%" height="100%" filter="url(#paper)"/>
    </svg>
  `;

  PAPER_TEXTURE_URL =
    `url('data:image/svg+xml;utf8,${encodeURIComponent(svg)}')`;
  return PAPER_TEXTURE_URL;
}
function isInsideMath(node) {
  let el = node.parentNode;
  while (el) {
    if (
      el.classList?.contains("katex") ||
      el.classList?.contains("ql-math") ||
      el.classList?.contains("katex-mathml")
    ) {
      return true;
    }
    el = el.parentNode;
  }
  return false;
}

function applyHandwritingEffect(root) {
    if (!HW.enabled) return;
    const anyEffectEnabled =
  // LINE
  HW.lineSlopeEnabled ||
  HW.lineSpacingNoiseEnabled ||
  HW.lineFontNoiseEnabled ||

  // WORD
  HW.wordBaselineEnabled ||
  HW.wordRotationEnabled ||
  HW.wordSpacingNoiseEnabled ||
  HW.letterSpacingNoiseEnabled ||

  // INK
  HW.inkBlurEnabled ||
  HW.inkFlowEnabled ||
  HW.inkShadowEnabled ||

  // PAPER
  HW.paperTextureEnabled ||
  HW.paperShadowEnabled;


if (!anyEffectEnabled) return;


    // --------------------------------------------------
    // Deterministic random (stable across runs)
    // --------------------------------------------------
    if (!window.HW_RAND) {
        const a = new Float32Array(8000);
        for (let i = 0; i < a.length; i++) a[i] = Math.random();
        window.HW_RAND = a;
        window.HW_RAND_INDEX = 0;
    }

    function R() {
        if (HW_RAND_INDEX >= HW_RAND.length) HW_RAND_INDEX = 0;
        return HW_RAND[HW_RAND_INDEX++];
    }

    // --------------------------------------------------
    // --------------------------------------------------
    const rootStyle = getComputedStyle(document.documentElement);

    

    // --------------------------------------------------
    // Walk TEXT NODES ONLY
    // --------------------------------------------------
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];

    while (walker.nextNode()) {
  const node = walker.currentNode;
  if (!node.nodeValue.trim()) continue;
  if (isInsideMath(node)) continue; // 🚫 skip math
  nodes.push(node);
}

    // --------------------------------------------------
    // Process each text node as a logical block
    // --------------------------------------------------
    nodes.forEach(textNode => {
        const text = textNode.nodeValue;
        const parent = textNode.parentNode;
const parentStyle = getComputedStyle(parent);

const BASE = {
  fontSize: parseFloat(parentStyle.fontSize),

  // line-height can be "normal" → handle safely
  lineHeight: (() => {
    const lh = parentStyle.lineHeight;
    if (lh === "normal") {
      return parseFloat(parentStyle.fontSize) * 1.3;
    }
    return parseFloat(lh);
  })(),

  // letter-spacing can be "normal"
  letterSpacing: (() => {
    const ls = parentStyle.letterSpacing;
    if (ls === "normal") return 0;
    return parseFloat(ls);
  })(),

  // word-spacing can be "normal"
  wordSpacing: (() => {
    const ws = parentStyle.wordSpacing;
    if (ws === "normal") return 0;
    return parseFloat(ws);
  })()
};

        const blockSpan = document.createElement("span");
        blockSpan.className = "hw-text-block";
        blockSpan.style.display = "inline";

        // ---------------- LINE-LEVEL NOISE ----------------

        // Line slope (visual only)
        const slope = HW.lineSlopeEnabled
            ? (R() * 2 - 1) * HW.lineSlopeMax
            : 0;

        // Line spacing noise (relative to real line-height)
        if (HW.lineSpacingNoiseEnabled) {
            blockSpan.style.lineHeight =
                `${BASE.lineHeight + R() * HW.lineSpacingNoiseMax}px`;
        }

        // Font size noise (relative to real font size)
        if (HW.lineFontNoiseEnabled) {
            blockSpan.style.fontSize =
                `${BASE.fontSize + (R() * 2 - 1) * HW.lineFontNoiseMax}px`;
        }

        // --------------------------------------------------
        // WORD PROCESSING
        // --------------------------------------------------
       const parts = text.split(/(\s+)/);
let wordIndex = 0;

parts.forEach(part => {
    if (!part.trim()) {
        blockSpan.appendChild(document.createTextNode(part));
        return;
    }

    const w = document.createElement("span");
    w.className = "hw-word";
    w.textContent = part;
    w.style.display = "inline-block";

    // =====================================================
    // TRANSFORM (baseline + rotation)
    // =====================================================
    let transforms = [];

    if (HW.lineSlopeEnabled || HW.wordBaselineEnabled) {
        const baseY = slope * wordIndex;
        const wobble = HW.wordBaselineEnabled
            ? (R() * 2 - 1) * HW.wordBaselineMax
            : 0;

        transforms.push(`translateY(${baseY + wobble}px)`);
    }

    if (HW.wordRotationEnabled) {
        const skew = (R() * 2 - 1) * HW.wordRotationMax;
        transforms.push(`skewX(${skew}deg)`);
    }

    if (transforms.length) {
        w.style.transform = transforms.join(" ");
    }

    // =====================================================
    // WORD SPACING
    // =====================================================
    if (HW.wordSpacingNoiseEnabled) {
        const NEG_RATIO = 0.25;
        const wordGapNoise =
            (R() * (1 + NEG_RATIO) - NEG_RATIO) * HW.wordSpacingNoiseMax;

        w.style.marginRight = `${wordGapNoise}px`;
    }

    // =====================================================
    // LETTER SPACING
    // =====================================================
    if (HW.letterSpacingNoiseEnabled) {
        const letterNoise = R() * HW.letterSpacingNoiseMax;
        w.style.letterSpacing = `${BASE.letterSpacing + letterNoise}px`;
    }

    // =====================================================
    // INK EFFECTS
    // =====================================================
    if (HW.inkBlurEnabled) {
        w.style.filter = `blur(${HW.inkBlurAmount}px)`;
    }

    if (HW.inkFlowEnabled) {
        w.style.opacity =
            1 - HW.inkFlowAmount * 0.15 + R() * 0.1;
    }

    if (HW.inkShadowEnabled) {
        w.style.textShadow =
            `${R() * HW.inkShadowAmount}px ` +
            `${R() * HW.inkShadowAmount}px ` +
            `0 rgba(0,0,0,0.25)`;
    }

    blockSpan.appendChild(w);
    wordIndex++;
});


        parent.replaceChild(blockSpan, textNode);
    });
   const page = root.querySelector("#heading_page");
if (!page) return;

/* --------------------------------
   RESET (important)
-------------------------------- */
page.style.backgroundImage = "";
page.style.backgroundSize = "";
page.style.backgroundBlendMode = "";

/* --------------------------------
   BUILD BACKGROUND STACK
-------------------------------- */
const backgrounds = [];
const sizes = [];

/* -------- PAPER SHADOW -------- */
if (HW.paperShadowEnabled) {
    const s = HW.paperShadowStrength;
    const angle = (R() * 150 - 75) * (R() < 0.5 ? -1 : 1);

    backgrounds.push(`
        linear-gradient(${angle}deg,
            rgba(0,0,0, ${1.0 * s}) 0%,
            rgba(0,0,0, ${0.85 * s}) 10%,
            rgba(0,0,0, ${0.55 * s}) 25%,
            rgba(0,0,0, ${0.28 * s}) 50%,
            rgba(0,0,0, ${0.15 * s}) 70%,
            rgba(0,0,0, 0) 100%
        )
    `);

    sizes.push("100% 100%");
}

/* -------- PAPER TEXTURE -------- */
if (HW.paperTextureEnabled) {
    backgrounds.push(getPaperTexture(HW.paperTextureStrength));
    sizes.push("300px 300px");
}

/* --------------------------------
   APPLY OR CLEAR
-------------------------------- */
if (backgrounds.length) {
    page.style.backgroundImage = backgrounds.join(",");
    page.style.backgroundSize = sizes.join(",");
    page.style.backgroundBlendMode = "multiply";
} else {
    // No effect enabled → clean paper
    page.style.background = "";
}

            // --------------------------------------------------
        // APPLY INK EFFECTS TO MATH (BLOCK LEVEL ONLY)
        // --------------------------------------------------
        const mathNodes = root.querySelectorAll(".ql-math, .katex");

        mathNodes.forEach(node => {
        // INK BLUR (visual only)
        if (HW.inkBlurEnabled) {
            node.style.filter =
            `blur(${HW.inkBlurAmount * (0.6 + R() * 0.4)}px)`;
        }

        // INK FLOW (opacity noise)
        if (HW.inkFlowEnabled) {
            node.style.opacity =
            1 - HW.inkFlowAmount * 0.15 + R() * 0.08;
        }

        // INK SHADOW
        if (HW.inkShadowEnabled) {
            node.style.textShadow =
            `${R() * HW.inkShadowAmount}px ${R() * HW.inkShadowAmount}px 0 rgba(0,0,0,0.25)`;
        }
        });

}






let captureRoot = null;
function destroyCaptureRoot() {
  if (!captureRoot) return;
  captureRoot.remove();
  captureRoot = null;
}

function initCaptureRoot() {
  destroyCaptureRoot();

  const original = document.getElementById("shadow-effect");
  const rect = original.getBoundingClientRect();
  
  // Use offsetWidth to ignore UI zoom so PDF dimension isn't clipped
  const physicalWidth = original.offsetWidth;
  const physicalHeight = original.offsetHeight;

  // EXACT deep clone
  captureRoot = original.cloneNode(true);

  // Freeze layout — but DO NOT change structure
  captureRoot.style.position = "fixed";
  captureRoot.style.left = "-100000px";
  captureRoot.style.top = "0";
  captureRoot.style.width = physicalWidth + "px";
  captureRoot.style.height = physicalHeight + "px";
  captureRoot.style.margin = "0";
  captureRoot.style.transform = "none";
  captureRoot.style.boxSizing = "border-box";

  document.body.appendChild(captureRoot);
}
async function renderPageForExport(pageData) {
  // Title
  captureRoot.querySelector("#top-margin").innerHTML =
    pageData.title || "";

  // Side
  captureRoot.querySelector("#left-margin-in").innerHTML =
    pageData.side || "";

  // Main content — EXACT container
  captureRoot.querySelector("#output-inner-container").innerHTML =
    pageData.quillHTML || "";

  // Images — EXACT behavior as live UI
  captureRoot.querySelectorAll(".top-img").forEach(e => e.remove());

  (pageData.images || []).forEach(info => {
    const img = document.createElement("img");
    img.className = "top-img";
    img.src = info.src;
    img.style.cssText = info.style;

    // IMPORTANT: append to SAME parent as original UI
    captureRoot.appendChild(img);
  });

  // Effects ONLY on clone
  applyHandwritingEffect(captureRoot);

  await waitForRender();
}

async function captureExportCanvas() {
  const outer = document.getElementById('outer-container');
  const oldZoom = outer ? outer.style.zoom : '';
  if (outer) outer.style.zoom = '1';

  try {
      const canvas = await html2canvas(captureRoot, {
        scale: 3,
    backgroundColor: null,
    useCORS: true,
    removeContainer: false, // REQUIRED

    // ================================
    // HARD DOM ISOLATION
    // ================================
    ignoreElements: (element) => {
      // Keep capture root itself
      if (element === captureRoot) return false;

      // Keep children of capture root
      if (captureRoot.contains(element)) return false;

      // Keep parents of capture root (html → body → wrappers)
      if (element.contains(captureRoot)) return false;

      // Keep required HEAD nodes
      if (
        element.nodeName === "HEAD" ||
        element.nodeName === "STYLE" ||
        element.nodeName === "META" ||
        element.nodeName === "LINK"
      ) {
        return false;
      }

      // Ignore EVERYTHING else
      return true;
    }
  });

  // ================================
  // 🔥 HARD CLEANUP OF html2canvas IFRAMES
  // ================================
  document.querySelectorAll(".html2canvas-container").forEach(el => {
    try {
      const iframe = el.contentWindow;
      if (iframe && iframe.document) {
        el.src = "about:blank";
        iframe.document.open();
        iframe.document.write("");
        iframe.document.close();
        iframe.close();
      }
    } catch (_) {}
    el.remove();
  });

  // ================================
  // FINAL STYLE CLEANUP
  // ================================
  
  return canvas;
  } finally {
      if (outer) outer.style.zoom = oldZoom;
  }
}



const ProgressLoader = {
  show(title = "Working…") {
    document.getElementById("progress-overlay").classList.remove("hidden");
    document.getElementById("progress-title").innerText = title;
    this.update(0, "Starting…");
  },

  update(percent, text, subtext = "") {
    document.getElementById("progress-fill").style.width = `${percent}%`;
    document.getElementById("progress-text").innerText = text;
    document.getElementById("progress-subtext").innerText = subtext;
  },

  hide() {
    document.getElementById("progress-overlay").classList.add("hidden");
  }
};

// ========================================================
// DOWNLOAD HANDLER (UNCHANGED LOGIC, HOOKED TO NEW CAPTURE)
// ========================================================
async function handleDownload(value) {
    await saveCurrentPage();
  if (value === "pdf-current") {
    await loadScript("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    downloadCurrentPagePDF();
  } 
  else if (value === "pdf-all") {
    await loadScript("https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js");
    await loadScript("https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js");
    downloadAllPagesAsPDF();
  }

  // Reset select dropdown
  document.getElementById('download_options').value = '';
}

// ========================================================
// PDF EXPORT (NOW USES captureShadowWithEffect)
// ========================================================
async function downloadAllPagesAsPDF() {
  ProgressLoader.show("Exporting PDF");

  initCaptureRoot();

  const total = pageOrder.length;
  let pdf = null;

  for (let i = 0; i < total; i++) {
    const percent = Math.round((i / total) * 100);

    ProgressLoader.update(
      percent,
      `Rendering page ${i + 1} of ${total}`,
      "Capturing page for PDF"
    );

    const pageData = await loadPage(pageOrder[i]);
    await renderPageForExport(pageData);

    const canvas = await captureExportCanvas();
    const imgData = canvas.toDataURL("image/png");

    const scale = 3;
    const pdfWidth = canvas.width / scale;
    const pdfHeight = canvas.height / scale;

    if (i === 0) {
      pdf = new window.jspdf.jsPDF('p', 'pt', [pdfWidth, pdfHeight]);
    } else {
      pdf.addPage([pdfWidth, pdfHeight], 'p');
      pdf.setPage(i + 1);
    }
    
    pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
    canvas.width = canvas.height = 0;

    await new Promise(r => setTimeout(r, 0));
  }

  pdf.save("assignment.pdf");
  ProgressLoader.update(100, "Completed", "PDF downloaded successfully");
  ProgressLoader.hide();

  const closeBtn = document.querySelector('.modern-close-btn');
  if (typeof showMainPopup === "function") {
    showMainPopup();
  }
  if (closeBtn) {
    setTimeout(() => {
      closeBtn.style.display = 'flex';
    }, 10000);
  }
}


// ========================================================
// WAIT FOR RENDER (KEEPING YOUR ORIGINAL HELPER)
// ========================================================
function waitForRender() {
  return new Promise(resolve => {
    requestAnimationFrame(() => {
      requestAnimationFrame(resolve);
    });
  });
}

// ========================================================
// SINGLE PAGE IMAGE EXPORT (USES SAME CAPTURE LOGIC)
// ========================================================
async function downloadCurrentPagePDF() {
  ProgressLoader.show("Exporting Page As PDF");

  ProgressLoader.update(30, "Preparing page");

  initCaptureRoot();

  const pageId = pageOrder[currentPageIndex];
  const pageData = await loadPage(pageId);

  ProgressLoader.update(60, "Rendering content");

  await renderPageForExport(pageData);
  const canvas = await captureExportCanvas();

  ProgressLoader.update(90, "Finalizing PDF");

  const scale = 3;
  const pdfWidth = canvas.width / scale;
  const pdfHeight = canvas.height / scale;

  const pdf = new window.jspdf.jsPDF('p', 'pt', [pdfWidth, pdfHeight]);
  const imgData = canvas.toDataURL("image/png");
  pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
  pdf.save("current_page.pdf");

  ProgressLoader.hide();
}

        let fabricLoaded = false;
        let fabricLoadingPromise = null;

        function loadFabricJS() {
            if (fabricLoaded) return Promise.resolve();
            if (fabricLoadingPromise) return fabricLoadingPromise;

            fabricLoadingPromise = new Promise((resolve, reject) => {
                const script = document.createElement("script");
                script.src = "https://cdn.jsdelivr.net/npm/fabric@5.2.4/dist/fabric.min.js";
                script.async = true;

                script.onload = () => {
                    fabricLoaded = true;
                    resolve();
                };

                script.onerror = reject;
                document.head.appendChild(script);
            });

            return fabricLoadingPromise;
        }

        let isDrawingMode = false; // Start with customization mode
        let canvas = null;

        function toggleMode() {
            const drawingContainer = document.getElementById('drawing-controls');
            const customizationBoxes = document.querySelectorAll('.input-box:not(#drawing-controls)');
            const toggleButton = document.getElementById('toggle-mode-button');

            if (isDrawingMode) {
                // Switch to Customization mode
                drawingContainer.style.display = 'none';
                customizationBoxes.forEach(box => box.style.display = 'block');
                toggleButton.innerText = 'Switch to Drawing';
                isDrawingMode = false;
            } else {
                // Switch to Drawing mode (lazy load Fabric)
                loadFabricJS().then(() => {
                    drawingContainer.style.display = 'block';
                    customizationBoxes.forEach(box => box.style.display = 'none');
                    toggleButton.innerText = 'Switch to Customization';

                    if (!canvas) initFabricCanvas(); // init only once
                    isDrawingMode = true;
                });
            }
        }

        document.getElementById("toggle-mode-button").addEventListener("click", toggleMode);


function initFabricCanvas() {
    if (canvas) return;
    canvas = new fabric.Canvas('drawing-canvas', { preserveObjectStacking:true, allowTouchScrolling:true });

    let currentTool = 'pen';
    const colorInput = document.getElementById('drawing-color');
    const widthInput = document.getElementById('drawing-size');

    let undoStack = [], redoStack = [];
    let isDrawingShape = false, shapeStart = null, currentShape = null;

    function configureBrush() {
      const brush = new fabric.PencilBrush(canvas);
      brush.width = parseInt(widthInput.value,10) || 4;
      brush.color = colorInput.value || '#000000';
      canvas.freeDrawingBrush = brush;
    }

    configureBrush();

    function saveState() {
      redoStack = [];
      try {
        const jsonStr = JSON.stringify(canvas.toJSON(['selectable']));
        if (!undoStack.length || undoStack[undoStack.length-1] !== jsonStr) undoStack.push(jsonStr);
        if (undoStack.length>50) undoStack.shift();
      } catch(e){ console.warn(e); }
    }

    let isRestoring = false;
    function restoreState(jsonStr) {
      try {
        isRestoring = true;
        canvas.clear();
        canvas.loadFromJSON(JSON.parse(jsonStr), ()=>{
          if(currentTool==='select') setObjectsSelectable(true); else setObjectsSelectable(false);
          canvas.renderAll();
          isRestoring=false;
          setTool('pen'); // switch back to pen after undo/redo/clear
        });
      } catch(e){ console.error(e); isRestoring=false; }
    }

    // canvas.on('object:added',()=>{if(!isRestoring) saveState();});
    canvas.on('object:modified',()=>{if(!isRestoring) saveState();});
    canvas.on('object:removed',()=>{if(!isRestoring) saveState();});

    function setObjectsSelectable(flag){
      canvas.discardActiveObject();
      canvas.forEachObject(obj=>{ obj.selectable=!!flag; obj.evented=!!flag; });
      canvas.requestRenderAll();
    }

    function eraseAt(point) {
      // remove only on click, not hover
      const objs = canvas.getObjects().slice().reverse();
      let removed = false;
      for(let obj of objs){
        const br = obj.getBoundingRect(true,true);
        if(point.x>=br.left && point.x<=br.left+br.width && point.y>=br.top && point.y<=br.top+br.height){
          canvas.remove(obj); removed=true; break;
        }
      }
      if(removed && !isRestoring) saveState();
    }

    function setTool(tool){
      currentTool=tool;
      isDrawingShape=false; shapeStart=null; currentShape=null;
      canvas.isDrawingMode=(tool==='pen');
      if(tool==='select'){ canvas.selection=true; setObjectsSelectable(true); }
      else{ canvas.selection=false; setObjectsSelectable(false); }
      if(tool==='pen') configureBrush();
      canvas.discardActiveObject(); canvas.requestRenderAll();
    }

    // Add the missing select button handler
    document.getElementById('tool-select').onclick=()=>setTool('select');
    document.getElementById('pen-button').onclick=()=>setTool('pen');
    document.getElementById('eraser-button').onclick=()=>setTool('eraser');
    document.getElementById('line-button').onclick=()=>setTool('line');
    document.getElementById('rectangle-button').onclick=()=>setTool('rect');
    document.getElementById('circle-button').onclick=()=>setTool('circle');
    
    document.getElementById('undo-button').onclick=()=>{ if(undoStack.length>1){ redoStack.push(undoStack.pop()); restoreState(undoStack[undoStack.length-1]); } };
    document.getElementById('redo-button').onclick=()=>{ if(redoStack.length>0){ const n=redoStack.pop(); undoStack.push(n); restoreState(n); } };
    document.getElementById('clear-button').onclick=()=>{ canvas.clear(); saveState(); setTool('pen'); };
    
    document.getElementById("add top of paper").addEventListener("click", addImageTop);
    document.getElementById('save-button').onclick=()=>{
      const dataURL=canvas.toDataURL({format:'png'});
      const link=document.createElement('a'); link.href=dataURL; link.download='canvas.png'; link.click();
    };

    document.getElementById('color-picker-button').onclick=()=>{ colorInput.click(); };
    colorInput.onchange=()=>{ if(canvas.freeDrawingBrush) canvas.freeDrawingBrush.color=colorInput.value; };
    widthInput.oninput=()=>{ if(canvas.freeDrawingBrush) canvas.freeDrawingBrush.width=parseInt(widthInput.value,10)||4; };

    function pointerToCanvas(e){ const p=canvas.getPointer(e.e||e); return {x:p.x,y:p.y}; }

    canvas.on('mouse:down', function(o){
      const p=pointerToCanvas(o);
      if(currentTool==='eraser') eraseAt(p);
      if(currentTool==='line'||currentTool==='rect'||currentTool==='circle'){
        isDrawingShape=true; shapeStart=p;
        if(currentTool==='line') currentShape=new fabric.Line([p.x,p.y,p.x,p.y],{stroke:colorInput.value,strokeWidth:parseInt(widthInput.value,10)||2,selectable:false});
        else if(currentTool==='rect') currentShape=new fabric.Rect({left:p.x,top:p.y,originX:'left',originY:'top',width:0,height:0,fill:'transparent',stroke:colorInput.value,strokeWidth:parseInt(widthInput.value,10)||2,selectable:false});
        else if(currentTool==='circle') currentShape=new fabric.Circle({left:p.x,top:p.y,originX:'center',originY:'center',radius:1,fill:'transparent',stroke:colorInput.value,strokeWidth:parseInt(widthInput.value,10)||2,selectable:false});
        if(currentShape) canvas.add(currentShape);
      }
    });

    canvas.on('mouse:move', function(o){
      const p=pointerToCanvas(o);
      if(!isDrawingShape||!currentShape) return;
      if(currentTool==='line') currentShape.set({x2:p.x,y2:p.y});
      else if(currentTool==='rect'){
        const l=Math.min(p.x,shapeStart.x),t=Math.min(p.y,shapeStart.y),w=Math.abs(p.x-shapeStart.x),h=Math.abs(p.y-shapeStart.y);
        currentShape.set({left:l,top:t,width:w,height:h});
      }
      else if(currentTool==='circle'){
        const dx=p.x-shapeStart.x,dy=p.y-shapeStart.y,r=Math.sqrt(dx*dx+dy*dy)/2,cx=(p.x+shapeStart.x)/2,cy=(p.y+shapeStart.y)/2;
        currentShape.set({left:cx,top:cy,radius:r});
      }
      currentShape.setCoords(); canvas.requestRenderAll();
    });

    canvas.on('mouse:up', function(){
      if(isDrawingShape&&currentShape){ currentShape.set({selectable:false}); currentShape.setCoords(); saveState(); }
      isDrawingShape=false; currentShape=null; shapeStart=null;
    });

    canvas.on('path:created', function(opt){ opt.path.set({selectable:currentTool==='select'}); saveState(); });
    canvas.on('object:selected', function(){ if(currentTool!=='select') canvas.discardActiveObject(); });

    window.addEventListener('resize', ()=>{ canvas.setWidth(canvas.upperCanvasEl.parentNode.clientWidth); canvas.setHeight(canvas.upperCanvasEl.parentNode.clientHeight); canvas.calcOffset(); });

    window.addEventListener('keydown', e=>{ if((e.ctrlKey||e.metaKey)&&e.key==='z') document.getElementById('undo-button').click(); if((e.ctrlKey||e.metaKey)&&(e.key==='y'||(e.shiftKey&&e.key==='Z'))) document.getElementById('redo-button').click(); if((e.key==='Delete'||e.key==='Backspace')&&canvas.getActiveObject()&&currentTool==='select') canvas.remove(canvas.getActiveObject()); });

    setTool('pen');
    window._fabricCanvas=canvas;

    function setCanvasSize() {
    if (!canvas) return;

    const container = document.getElementById("canvas-container");
    if (!container) return;

    const widthPct  = document.getElementById("canvas-width").valueAsNumber;
    const heightPct = document.getElementById("canvas-height").valueAsNumber;

    const w = container.clientWidth  * widthPct  / 100;
    const h = container.clientHeight * heightPct / 100;

    canvas.setWidth(w);
    canvas.setHeight(h);
    canvas.calcOffset();
    canvas.requestRenderAll();
}

document.getElementById("canvas-width").addEventListener("input", setCanvasSize);
document.getElementById("canvas-height").addEventListener("input", setCanvasSize);
setCanvasSize()

}



  



// =======================================================
// GLOBAL STATE
// =======================================================
let interactLoaded = false;
let selectedTopImage = null;

// =======================================================
// LAZY LOAD INTERACT.JS
// =======================================================
function loadInteract() {
    if (interactLoaded) return Promise.resolve();

    return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/interactjs/dist/interact.min.js";

        script.onload = () => {
            interactLoaded = true;
            resolve();
        };

        script.onerror = reject;
        document.body.appendChild(script);
    });
}

// =======================================================
// INIT INTERACT (DRAG + RESIZE)
// =======================================================
function initInteractForImages() {
    interact(".top-img")
        .draggable({
            listeners: {
                move(event) {
                    const target = event.target;

                    let x = (parseFloat(target.dataset.x) || 0) + event.dx;
                    let y = (parseFloat(target.dataset.y) || 0) + event.dy;

                    target.style.transform = `translate(${x}px, ${y}px)`;
                    target.dataset.x = x;
                    target.dataset.y = y;
                }
            }
        })
        .resizable({
            edges: { left: true, right: true, bottom: true, top: true },
            listeners: {
                move(event) {
                    const target = event.target;

                    let x = (parseFloat(target.dataset.x) || 0) + event.deltaRect.left;
                    let y = (parseFloat(target.dataset.y) || 0) + event.deltaRect.top;

                    Object.assign(target.style, {
                        width: `${event.rect.width}px`,
                        height: `${event.rect.height}px`,
                        transform: `translate(${x}px, ${y}px)`
                    });

                    target.dataset.x = x;
                    target.dataset.y = y;
                }
            }
        });
}

// =======================================================
// IMAGE SELECTION (CLICK)
// =======================================================
const deleteBtn = document.getElementById("delete-image-btn");

document.addEventListener("click", (e) => {
    const images = document.querySelectorAll(".top-img");
    images.forEach(img => img.style.border = "none");

    if (e.target.classList.contains("top-img")) {
        selectedTopImage = e.target;
        selectedTopImage.style.border = "2px dashed #000";
        deleteBtn.style.display = "block";
    } else {
        selectedTopImage = null;
        deleteBtn.style.display = "none";
    }
});
deleteBtn.addEventListener("click", () => {
    if (!selectedTopImage) return;

    selectedTopImage.remove();
    selectedTopImage = null;
    deleteBtn.style.display = "none";
});


// =======================================================
// DELETE IMAGE (KEYBOARD ONLY)
// =======================================================
document.addEventListener("keydown", (e) => {
    if (!selectedTopImage) return;

    if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        selectedTopImage.remove();
        selectedTopImage = null;
    }
});


// =======================================================
// CREATE IMAGE ELEMENT
// =======================================================
function createTopImageElement(src) {
    const img = document.createElement("img");
    img.src = src;

    img.className = "top-img";
    img.style.position = "absolute";
    img.style.zIndex = 10; // FIXED
    img.style.top = "0px";
    img.style.left = "0px";

    img.dataset.x = 10;
    img.dataset.y = 10;
    img.style.transform = "translate(10px, 10px)";

    img.style.width = "150px";
    img.style.height = "auto";
    img.style.cursor = "move";
    img.style.touchAction = "none";

    return img;
}

// =======================================================
// ADD IMAGE FROM CANVAS (YOUR FLOW)
// =======================================================
async function addImageTop() {
    const canvas = document.getElementById("drawing-canvas");
    const container = document.getElementById("shadow-effect");

    if (!canvas || !container) return;

    // Convert canvas → image
    const dataUrl = canvas.toDataURL("image/png");

    const img = createTopImageElement(dataUrl);
    container.appendChild(img);

    // Lazy-load interact.js once
    await loadInteract();

    if (!window._interactInitialized) {
        initInteractForImages();
        window._interactInitialized = true;
    }
}

