        import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
        import { getDatabase, ref as dbRef, set, onValue, get, remove } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";
        import { getStorage, ref as storageRef, uploadBytes, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-storage.js";

        const firebaseConfig = {
            apiKey: "AIzaSyBvJ_lGnmH3Dll1E-HY5CuqzKGqQBXb-C4",
            authDomain: "okmusic-ec226.firebaseapp.com",
            databaseURL: "https://okmusic-ec226-default-rtdb.europe-west1.firebasedatabase.app",
            projectId: "okmusic-ec226",
            storageBucket: "okmusic-ec226.firebasestorage.app",
            messagingSenderId: "11941678108",
            appId: "1:11941678108:web:9018d318982cd779a563d9",
            measurementId: "G-K4153S4SKS"
        };
        
        // REPLACE THE ABOVE CONFIG WITH YOUR OWN FIREBASE KEYS

        let app, db, storage;
        try {
            app = initializeApp(firebaseConfig);
            db = getDatabase(app);
            storage = getStorage(app);
            storage.maxUploadRetryTime = 1200000; // Increase to 20 minutes for large libraries
            storage.maxOperationRetryTime = 1200000;
            
            window.serverTimeOffset = 0;
            onValue(dbRef(db, '.info/serverTimeOffset'), (snap) => {
                window.serverTimeOffset = snap.val() || 0;
            });
        } catch(e) { console.error("Firebase init failed", e); }

        window.db = db;
        window.storage = storage;
        window.dbRef = dbRef;
        window.storageRef = storageRef;
        window.setDb = set;
        window.onDbValue = onValue;
        window.getDb = get;
        window.uploadBytes = uploadBytes;
        window.uploadBytesResumable = uploadBytesResumable;
        window.getDownloadURL = getDownloadURL;

        // --- GLOBAL HELPERS ---
        window.$ = id => document.getElementById(id);
        const formatTime = (time) => {
            if (isNaN(time)) return "0:00";
            const min = Math.floor(time / 60);
            const sec = Math.floor(time % 60);
            return `${min}:${sec.toString().padStart(2, '0')}`;
        };
        
        window.toggleDisplayMode = () => {
            document.body.classList.toggle('display-mode');
            if(document.body.classList.contains('display-mode')) {
                if(document.documentElement.requestFullscreen) {
                    document.documentElement.requestFullscreen().catch((e)=>console.log(e));
                }
            } else {
                document.getElementById('playerWrapper').style.transform = `translate(-50%, -50%) scale(1)`; 
                if(document.fullscreenElement && document.exitFullscreen) {
                    document.exitFullscreen().catch((e)=>console.log(e));
                }
            }
        };

        window.displayScale = 1.0;
        // Pinch to Zoom Logic for Display Mode
        document.addEventListener('DOMContentLoaded', () => {
            let initialDistance = null;
            const pw = document.getElementById('playerWrapper');
            const applyZoom = (scale) => {
                window.displayScale = scale;
                pw.style.transform = `translate(-50%, -50%) scale(${scale * 0.9})`;
            };
            
            pw.addEventListener('wheel', (e) => {
                if(!document.body.classList.contains('display-mode')) return;
                e.preventDefault();
                let nextScale = window.displayScale + (e.deltaY * -0.001);
                applyZoom(Math.min(Math.max(0.4, nextScale), 3));
            }, {passive: false});

            pw.addEventListener('touchstart', (e) => {
                if(!document.body.classList.contains('display-mode') || e.touches.length !== 2) return;
                initialDistance = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
            }, {passive: false});

            pw.addEventListener('touchmove', (e) => {
                if(!document.body.classList.contains('display-mode') || e.touches.length !== 2 || !initialDistance) return;
                e.preventDefault();
                const currentDist = Math.hypot(e.touches[0].pageX - e.touches[1].pageX, e.touches[0].pageY - e.touches[1].pageY);
                const delta = currentDist - initialDistance;
                let nextScale = window.displayScale + (delta * 0.005);
                applyZoom(Math.min(Math.max(0.4, nextScale), 3));
                initialDistance = currentDist;
            }, {passive: false});
            
            pw.addEventListener('touchend', () => initialDistance = null);
        });
        // --- CLASSES DEFINITION ---

        class AudioExporter {
            async exportAudio() {
                if(!window.player.currentTrack) return alert("Play a song first!");
                const btn = document.querySelector('button i.fa-download').parentElement;
                const oldText = btn.innerHTML;
                btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Rendering...`;
                btn.disabled = true;

                try {
                    const track = window.player.currentTrack;
                    const blob = await fetch(URL.createObjectURL(track.blob)).then(r => r.arrayBuffer());
                    
                    const offlineCtx = new OfflineAudioContext(2, 44100 * 60, 44100); 
                    const audioBuffer = await offlineCtx.decodeAudioData(blob);
                    const speed = window.audioSys.baseSpeed;
                    const duration = audioBuffer.duration / speed;
                    const renderCtx = new OfflineAudioContext(2, duration * 44100, 44100);
                    
                    const src = renderCtx.createBufferSource();
                    src.buffer = audioBuffer;
                    src.playbackRate.value = speed;
                    const bass = renderCtx.createBiquadFilter();
                    bass.type = "lowshelf"; bass.frequency.value = 200; bass.gain.value = window.audioSys.bassVal;
                    const reverb = renderCtx.createConvolver();
                    const impulse = renderCtx.createBuffer(2, 44100 * 3, 44100);
                    for(let i=0; i<44100*3; i++) {
                         impulse.getChannelData(0)[i] = (Math.random()*2-1)*Math.exp(-3*i/(44100*3));
                         impulse.getChannelData(1)[i] = (Math.random()*2-1)*Math.exp(-3*i/(44100*3));
                    }
                    reverb.buffer = impulse;
                    const revGain = renderCtx.createGain();
                    revGain.gain.value = window.audioSys.reverbVal / 100;

                    src.connect(bass); bass.connect(renderCtx.destination);
                    bass.connect(reverb); reverb.connect(revGain); revGain.connect(renderCtx.destination);
                    src.start();

                    const rendered = await renderCtx.startRendering();
                    const wavBuffer = this.bufferToWav(rendered);
                    
                    const finalBlob = new Blob([wavBuffer], { type: 'audio/wav' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(finalBlob);
                    a.download = `Processed_${track.name}.wav`;
                    a.click();

                } catch(e) { alert("Export Failed: " + e.message); console.error(e); }
                btn.innerHTML = oldText; btn.disabled = false;
            }

            bufferToWav(abuffer) {
                const numOfChan = abuffer.numberOfChannels, length = abuffer.length * numOfChan * 2 + 44, buffer = new ArrayBuffer(length), view = new DataView(buffer), channels = [];
                let i=0, sample=0, offset=0, pos=0;
                setUint32(0x46464952); setUint32(length - 8); setUint32(0x45564157);
                setUint32(0x20746d66); setUint32(16); setUint16(1); setUint16(numOfChan); setUint32(abuffer.sampleRate); setUint32(abuffer.sampleRate * 2 * numOfChan); setUint16(numOfChan * 2); setUint16(16);
                setUint32(0x61746164); setUint32(length - pos - 4);
                for(i = 0; i < abuffer.numberOfChannels; i++) channels.push(abuffer.getChannelData(i));
                while(pos < length) {
                    for(i = 0; i < numOfChan; i++) {
                        sample = Math.max(-1, Math.min(1, channels[i][offset])); 
                        sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767)|0; 
                        view.setInt16(pos, sample, true); pos += 2;
                    }
                    offset++;
                }
                return buffer;
                function setUint16(data) { view.setUint16(pos, data, true); pos += 2; }
                function setUint32(data) { view.setUint32(pos, data, true); pos += 4; }
            }
        };

        class MusicDB {
            constructor() { this.name="SonicVaultV8.0"; this.v=3; this.db=null; }
            async init() { return new Promise(r=>{const q=indexedDB.open(this.name,this.v); q.onupgradeneeded=e=>{const db=e.target.result; if(db.objectStoreNames.contains("songs")) db.deleteObjectStore("songs"); db.createObjectStore("songs",{keyPath:"id"});}; q.onsuccess=e=>{this.db=e.target.result;r()};}); }
            async add(f, data = null) { 
                return new Promise((r,j)=>{
                    const id=crypto.randomUUID(); 
                    const t=this.db.transaction(["songs"],"readwrite"); 
                    const baseName = f.name.replace(/\.[^/.]+$/,"");
                    const entry = {
                        id: id,
                        name: baseName,
                        blob: f,
                        art: null,
                        beatSignals: data ? data.beatSignals : [],
                        isNew: true // Mark as new song
                    };
                    if(data && data.speedPoints) entry.speedPoints = data.speedPoints;

                    t.objectStore("songs").add(entry).onsuccess=()=>r(id); 
                    t.onerror=j;
                }); 
            }
            async update(id,d) { return new Promise(r=>{const t=this.db.transaction(["songs"],"readwrite");const s=t.objectStore("songs");s.get(id).onsuccess=e=>{const i=e.target.result;if(i){Object.assign(i,d);s.put(i).onsuccess=()=>r()}}}); }
            async delete(id) { return new Promise(r=>{const t=this.db.transaction(["songs"],"readwrite");t.objectStore("songs").delete(id).onsuccess=()=>r();}); }
            async getAll() { return new Promise(r=>{const t=this.db.transaction(["songs"],"readonly");t.objectStore("songs").getAll().onsuccess=e=>r(e.target.result)}); }
            async clearAll() { if(confirm("Factory Reset?")){ const tx=this.db.transaction(["songs"],"readwrite"); tx.objectStore("songs").clear(); localStorage.clear(); location.reload(); } }
            async markAsSeen(id) { return this.update(id, { isNew: false }); }
        };

        class LibraryManager {
            constructor() { try { this.structure = JSON.parse(localStorage.getItem('sv_library_struct')); } catch(e) {} if(!Array.isArray(this.structure)) this.structure = []; this.dragSrc = null; this.dropTarget = null; }
            save() { localStorage.setItem('sv_library_struct', JSON.stringify(this.structure)); }
            sync(songs) {
                const dbIds=new Set(songs.map(s=>s.id)), structIds=new Set();
                const clean=(list)=>{ for(let i=list.length-1;i>=0;i--){ if(list[i].type==='song'){ if(!dbIds.has(list[i].id))list.splice(i,1); else structIds.add(list[i].id); } else if(list[i].type==='folder') clean(list[i].items); } };
                clean(this.structure); songs.forEach(s=>{ if(!structIds.has(s.id)) this.structure.push({type:'song',id:s.id}); }); this.save(); window.ui.renderLibrary();
            }
            openFolderModal(){ window.$('folderModal').style.opacity='1'; window.$('folderModal').style.pointerEvents='auto'; window.$('folderNameInput').value=''; window.$('folderNameInput').focus(); }
            closeFolderModal(){ window.$('folderModal').style.opacity='0'; window.$('folderModal').style.pointerEvents='none'; }
            confirmCreateFolder(){ const name=window.$('folderNameInput').value||"New Folder"; const id=crypto.randomUUID(); this.structure.unshift({type:'folder',id:id,name:name,art:null,items:[],isOpen:true, color: null}); this.save(); this.closeFolderModal(); window.ui.renderLibrary(); }
            deleteItem(id){ const remove=(list)=>{ const idx=list.findIndex(x=>x.id===id); if(idx>-1){ const item=list[idx]; if(item.type==='song') window.player.db.delete(item.id); else if(item.type==='folder'&&item.items.length>0) this.structure.push(...item.items); list.splice(idx,1); return true; } for(let item of list) if(item.type==='folder'&&remove(item.items)) return true; return false; }; remove(this.structure); this.save(); window.ui.renderLibrary(); }
            findItem(id,list=this.structure){ for(let item of list){ if(item.id===id)return item; if(item.type==='folder'){ const found=this.findItem(id,item.items); if(found)return found; }} return null; }
            updateFolder(id,d){ const f=this.findItem(id); if(f){ Object.assign(f,d); this.save(); window.ui.renderLibrary(); } }
            removeItemFromStructure(id, list = this.structure) {
                const idx = list.findIndex(x => x.id === id);
                if (idx > -1) { list.splice(idx, 1); return true; }
                for (const item of list) {
                    if (item.type === 'folder' && this.removeItemFromStructure(id, item.items)) return true;
                }
                return false;
            }
            
            async shareLibrary() {
                if(!window.db || !window.storage) return alert("Firebase not connected.");
                const btn = window.$('shareLibBtn');
                const oldHtml = btn.innerHTML;
                btn.style.backgroundColor = 'var(--accent)';
                btn.style.color = 'black';
                
                try {
                    const shareId = Math.random().toString(36).substring(2,8).toUpperCase();
                    const songsToShare = [];
                    const flatList = window.ui.getFlatList();
                    const total = flatList.length;

                    for(let i=0; i<total; i++) {
                        const id = flatList[i];
                        const song = window.player.songs.find(s=>s.id===id);
                        if(song) {
                            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> ${i+1}/${total}`;
                            const sRef = window.storageRef(window.storage, `sharedLibs/${shareId}/${song.id}.mp3`);
                            
                            let success = false;
                            for(let attempt=0; attempt<3; attempt++) {
                                try {
                                    await window.uploadBytes(sRef, song.blob);
                                    const downloadUrl = await window.getDownloadURL(sRef);
                                    songsToShare.push({
                                        id: song.id, name: song.name, storageUrl: downloadUrl,
                                        beatSignals: song.beatSignals || [], speedPoints: song.speedPoints || []
                                    });
                                    success = true;
                                    break;
                                } catch(err) {
                                    console.error(`Upload failed (Attempt ${attempt+1}/3): ${song.name}`, err);
                                    if(attempt === 2) throw err;
                                    await new Promise(r => setTimeout(r, 2000));
                                }
                            }
                        }
                    }
                    
                    const struct = JSON.parse(JSON.stringify(this.structure));
                    await window.setDb(window.dbRef(window.db, 'sharedLibs/' + shareId), {
                        structure: struct, songs: songsToShare, timestamp: Date.now()
                    });
                    
                    const shareUrl = window.location.origin + window.location.pathname + "?playlist=" + shareId;
                    navigator.clipboard.writeText(shareUrl);
                    alert("Library Uploaded! Link copied to clipboard:\n" + shareUrl);
                } catch(e) { 
                    alert("Share Failed: " + e.message); 
                    console.error(e); 
                    window.ui.showToast("Network Error: Sharing stopped.");
                }
                btn.innerHTML = oldHtml;
                btn.style.backgroundColor = ''; btn.style.color = '';
            }
            
            async loadSharedLibrary(shareId) {
                if(!window.db) return;
                const status = window.$('syncStatus');
                status.innerText = "Downloading Shared Library..."; status.style.display = 'inline-block';
                try {
                    const snap = await window.getDb(window.dbRef(window.db, 'sharedLibs/' + shareId));
                    if(snap.exists()) {
                        const data = snap.val();
                        if (data && data.songs) {
                            for(const s of data.songs) {
                                let fetchUrl = s.storageUrl || s.data;
                                if (!fetchUrl) continue;
                                const res = await fetch(fetchUrl);
                                const blob = await res.blob();
                                blob.name = s.name + ".mp3";
                                await window.player.db.add(blob, {beatSignals: s.beatSignals, speedPoints: s.speedPoints});
                            }
                            this.structure = data.structure;
                            this.save();
                            await window.player.loadLib();
                        }
                        status.innerText = "Library Downloaded!"; setTimeout(() => status.style.display='none', 3000);
                        const newUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
                        window.history.pushState({path:newUrl},'',newUrl);
                    } else {
                        status.innerText = "Shared Library Not Found"; setTimeout(() => status.style.display='none', 3000);
                    }
                } catch(e) { console.error("Load shared lib error", e); status.style.display='none'; }
            }

            async exportLibrary() {
                try {
                    const allSongs = window.player.songs;
                    const chunks = [];
                    chunks.push(`{"structure":${JSON.stringify(this.structure)},"songs":[`);
                    
                    for (let i = 0; i < allSongs.length; i++) {
                        const s = allSongs[i];
                        const base64 = await new Promise(r => { const reader = new FileReader(); reader.onloadend = () => r(reader.result); reader.readAsDataURL(s.blob); });
                        const songObj = { id: s.id, name: s.name, b64: base64, beatSignals: s.beatSignals || [], speedPoints: s.speedPoints || [] };
                        chunks.push(JSON.stringify(songObj));
                        if (i < allSongs.length - 1) chunks.push(",");
                    }
                    chunks.push("]}");
                    
                    const blob = new Blob(chunks, { type: "application/json" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url; a.download = `okMUSIC_Library_${Date.now()}.json`;
                    a.click();
                    URL.revokeObjectURL(url);
                    window.ui.showToast("Library Exported!");
                } catch (e) { 
                    console.error("Export Error:", e); 
                    window.ui.showToast("Export Failed! Check console."); 
                }
            }

            async importLibrary(input) {
                if (!input.files || input.files.length === 0) return;
                try {
                    const file = input.files[0];
                    const text = await file.text();
                    const data = JSON.parse(text);
                    if (data && data.songs) {
                        for (const s of data.songs) {
                            if (!s.b64) continue;
                            const res = await fetch(s.b64);
                            const blob = await res.blob();
                            blob.name = s.name + ".mp3";
                            await window.player.db.add(blob, { beatSignals: s.beatSignals, speedPoints: s.speedPoints });
                        }
                        this.structure = data.structure || [];
                        this.save();
                        await window.player.loadLib();
                        window.ui.showToast("Library Imported Successfully!");
                    } else { window.ui.showToast("Invalid library file."); }
                } catch(e) { console.error(e); window.ui.showToast("Import Failed!"); }
            }
        };

        class VolumeAnim {
            constructor(elementId) {
                this.elementId = elementId;
                this.currentValue = 0;
                this.targetValue = 0;
                this.velocity = 0;
                this.animFrame = null;
                this.lastTime = 0;
                this.active = false;
            }

            animateTo(targetV) {
                const target = targetV * 100;
                this.targetValue = target;
                if(!this.active) {
                    this.active = true;
                    this.lastTime = performance.now();
                    this.step();
                }
            }

            step() {
                const now = performance.now();
                const dt = Math.min((now - this.lastTime) / 1000, 0.05); // Cap dt
                this.lastTime = now;

                // Simple Spring Physics parameters
                const tension = 150;
                const friction = 16;
                
                const force = (this.targetValue - this.currentValue) * tension;
                this.velocity += force * dt;
                this.velocity *= (1 - friction * dt);
                this.currentValue += this.velocity * dt;

                if(Math.abs(this.targetValue - this.currentValue) < 0.1 && Math.abs(this.velocity) < 0.1) {
                    this.currentValue = this.targetValue;
                    this.active = false;
                }

                const display = window.$(this.elementId);
                if(display && document.activeElement !== display) {
                    display.value = Math.round(this.currentValue) + '%';
                    
                    // Dynamic glow and pop based on target percentage
                    const targetGlow = Math.max(0, this.targetValue) / 100;
                    display.style.textShadow = `0 0 ${targetGlow * 20}px rgba(255,42,42,${targetGlow}), 0 0 ${targetGlow * 10}px rgba(255,42,42,${targetGlow * 0.8})`;
                    display.style.color = '#fff';
                    display.style.opacity = 0.5 + (0.5 * targetGlow);
                    display.style.transform = `scale(${1 + (targetGlow * 0.25)})`;
                }

                if(this.active) {
                    this.animFrame = requestAnimationFrame(() => this.step());
                }
            }
        }

        
class okMUSICLearningController {
    constructor(audioNode) {
        this.workletNode = audioNode;
        this.learningRate = 0.05; 
        this.alphaLearningRate = 0.1; 
        
        this.weights = new Float32Array([1.0, 1.0, 1.0]); 
        this.alphaMultiplier = 2.5;

        // Cache for all frames generated during playback (approx 86 frames per second).
        this.featureHistory = [];
        this.maxHistoryLength = 20000; // Stores roughly ~4 minutes of playback frames
        
        this.loadState();

        this.workletNode.port.onmessage = (event) => {
            if (event.data.type === 'FEATURE_VECTOR') {
                if(window.audioSys && window.audioSys.audio && !window.audioSys.audio.paused) {
                    event.data.trackTime = window.audioSys.audio.currentTime;
                    this.cacheFeatureVector(event.data);
                }
            }
            if (event.data.type === 'ONSET_DETECTED') {
                this.triggerVisuals(event.data.flux); 
            }
        };
        
        this.syncWithWorklet();
    }

    triggerVisuals(flux) {
        // Find existing curve canvas and cause a slight "pulse" for feedback if timeline is open
        if(window.curveEditor && window.curveEditor.isOpen) {
            window.curveEditor.pulse = 1.0;
        }
    }

    cacheFeatureVector(data) {
        this.featureHistory.push(data);
        if (this.featureHistory.length > this.maxHistoryLength) {
            this.featureHistory.shift();
        }
    }

    // Triggered from Curve Editor when user clicks "TEACH ALGORITHM"
    learnFromTimeline(userBeatSignals) {
        console.log("Analyzing " + userBeatSignals.length + " user beats against " + this.featureHistory.length + " cached frames...");
        
        let falseNegatives = 0;
        let falsePositives = 0;

        // 1. Find False Negatives (User placed a beat, but algorithm scored it below threshold)
        for(let ub of userBeatSignals) {
            let userTime = ub.time || ub; // support objects or arrays of numbers
            
            // Find the closest frame within a 150ms window
            let closestFrame = this.featureHistory.reduce((prev, curr) => {
                return (Math.abs(curr.trackTime - userTime) < Math.abs(prev.trackTime - userTime)) ? curr : prev;
            }, this.featureHistory[0]);

            if (closestFrame && Math.abs(closestFrame.trackTime - userTime) < 0.2) {
                // We assume if user placed it, it's a TRUE BEAT (1.0).
                this.applyGradientDescent(closestFrame.features, closestFrame.prediction, 1.0);
                // Lower threshold to catch it next time
                this.alphaMultiplier = Math.max(1.0, this.alphaMultiplier - (this.alphaLearningRate * 0.5));
                falseNegatives++;
            }
        }

        // 2. Find False Positives (Algorithm predicted a beat, but it's not near ANY user point)
        // We simulate the worklet's peak picking to find what it *would* have triggered
        // But for simplicity, we just look for high-prediction frames that aren't near user beats.
        for(let frame of this.featureHistory) {
            // Did this frame strongly predict a beat? (rough static assumption based on weights)
            let predictedScore = (frame.features[0] * this.weights[0]) + (frame.features[1] * this.weights[1]) + (frame.features[2] * this.weights[2]);
            
            if (predictedScore > 0.05) { // Arbitrary flux threshold indicating significant energy
                // Is this near any user point?
                let isNearUserPoint = userBeatSignals.some(ub => {
                    let userTime = ub.time || ub;
                    return Math.abs(frame.trackTime - userTime) < 0.25;
                });

                if (!isNearUserPoint) {
                    // Algorithm fired/saw high energy, but user didn't mark a beat here. False Positive.
                    this.applyGradientDescent(frame.features, predictedScore, 0.0);
                    // Raise threshold
                    this.alphaMultiplier = Math.min(5.0, this.alphaMultiplier + (this.alphaLearningRate * 0.1));
                    falsePositives++;
                }
            }
        }
        
        this.syncWithWorklet();
        this.saveState();
        
        // Show notification Toast
        if(window.ui && window.ui.showToast) {
            window.ui.showToast(`Neural Network Updated: Fixed ${falseNegatives} misses & ${falsePositives} false positives.`);
        }
        console.log("Timeline Teaching Complete. Weights:", this.weights, "Threshold Alpha:", this.alphaMultiplier);
    }

    applyGradientDescent(features, prediction, yTrue) {
        let maxFeature = Math.max(...features, 0.0001);
        let x = features.map(f => f / maxFeature);
        let error = yTrue - prediction;
        for (let i = 0; i < this.weights.length; i++) {
            this.weights[i] += this.learningRate * error * x[i];
            this.weights[i] = Math.max(0.1, this.weights[i]); 
        }
    }

    syncWithWorklet() {
        if(this.workletNode) {
            this.workletNode.port.postMessage({
                type: 'UPDATE_WEIGHTS',
                weights: [this.weights[0], this.weights[1], this.weights[2]],
                alpha: this.alphaMultiplier
            });
        }
    }
    
    saveState() {
        if(window.player && window.player.currentTrack) {
            const trackId = window.player.currentTrack.id;
            const state = {
                weights: [this.weights[0], this.weights[1], this.weights[2]],
                alphaMultiplier: this.alphaMultiplier
            };
            localStorage.setItem('bass_learning_' + trackId, JSON.stringify(state));
        }
    }
    
    loadState() {
        if(window.player && window.player.currentTrack) {
            const trackId = window.player.currentTrack.id;
            const saved = localStorage.getItem('bass_learning_' + trackId);
            if(saved) {
                try {
                    const data = JSON.parse(saved);
                    this.weights = new Float32Array(data.weights);
                    this.alphaMultiplier = data.alphaMultiplier;
                    this.syncWithWorklet();
                } catch(e) {}
            }
        }
    }
}
        class AudioSystem {
            constructor() { this.ctx=null; this.audio=new Audio(); this.audio.crossOrigin="anonymous"; this.audio.addEventListener('timeupdate',()=>window.player.onTick()); this.audio.addEventListener('ended',()=>window.player.onEnd()); this.baseSpeed=1.0; this.bassVal=0; this.reverbVal=0; this.globalAudio=false; this.xtremeOn=false; this.bassCurve=[]; this.initBassCurve(); this.volAnim = new VolumeAnim('volPercentDisplay'); setTimeout(()=>this.volAnim.animateTo(1), 500); }
            async init() { 
                if(this.ctx)return; 
                const AC=window.AudioContext||window.webkitAudioContext; 
                this.ctx=new AC(); 
                this.src=this.ctx.createMediaElementSource(this.audio); 
                this.bass=this.ctx.createBiquadFilter(); 
                this.bass.type="lowshelf"; 
                this.bass.frequency.value=200; 
                this.analyser=this.ctx.createAnalyser(); 
                this.analyser.fftSize=2048; 
                this.reverb=this.ctx.createConvolver(); 
                this.reverb.buffer=this.impulse(3); 
                this.revGain=this.ctx.createGain(); 
                this.revGain.gain.value=0; 
                this.gain=this.ctx.createGain(); 
                this.src.connect(this.bass); 
                this.bass.connect(this.analyser); 
                this.bass.connect(this.reverb); 
                this.reverb.connect(this.revGain); 
                this.revGain.connect(this.gain); 
                this.bass.connect(this.gain); 
                this.gain.connect(this.ctx.destination); 
                
                try {
                    await this.ctx.audioWorklet.addModule('assets/js/bass-worklet.js');
                    this.bassDetectorNode = new AudioWorkletNode(this.ctx, 'adaptive-bass-detector');
                    this.src.connect(this.bassDetectorNode);
                    this.learningController = new okMUSICLearningController(this.bassDetectorNode);
                    window.learningController = this.learningController;
                    console.log("Advanced Bass Detection AudioWorklet injected.");
                } catch(e) {
                    console.error("AudioWorklet failed to load:", e);
                }
                
                window.viz.start(); 
            }
            impulse(d){const r=this.ctx.sampleRate,l=r*d,b=this.ctx.createBuffer(2,l,r);for(let c=0;c<2;c++){const d=b.getChannelData(c);for(let i=0;i<l;i++)d[i]=(Math.random()*2-1)*Math.pow(1-i/l,2);}return b;}
            
            toggleGlobal(on) { this.globalAudio = on; localStorage.setItem('sv_global_audio', on); }
            
            toggleXtreme() {
                const check = window.$('xtremeToggle');
                const on = check ? check.checked : false; 
                this.xtremeOn = on;
                if(this.globalAudio) localStorage.setItem('sv_xtreme', on);
                else if(window.player && window.player.currentTrack) { 
                    window.player.currentTrack.xtremeOn = on; 
                    window.player.db.update(window.player.currentTrack.id, {xtremeOn: on}); 
                }
                if(window.ui && window.ui.updateMetaTags) window.ui.updateMetaTags();
                this.updateDynamicBass();
                this.broadcastFx();
            }

            toggleBassCurve(on) {
                this.curveEnabled = on;
                localStorage.setItem('sv_curve_enabled', on);
                this.updateDynamicBass();
            }

            initBassCurve() {
                this.curveEnabled = localStorage.getItem('sv_curve_enabled') !== 'false';
                this.bassCurve = JSON.parse(localStorage.getItem('sv_bass_curve')) || [
                    { id: 1, vol: 20, bass: 14 },
                    { id: 2, vol: 90, bass: 3 }
                ];
                // Try to render and sync if DOM is ready
                setTimeout(() => {
                    this.renderCurveNodes();
                    const toggle = window.$('curveToggle');
                    if(toggle) toggle.checked = this.curveEnabled;
                }, 500);
            }

            saveBassCurve() {
                localStorage.setItem('sv_bass_curve', JSON.stringify(this.bassCurve));
                this.updateDynamicBass();
            }

            addCurveNodeLive() {
                if(!this.gain) return;
                const currentVol = Math.round(this.gain.gain.value * 100);
                const currentBass = parseInt(this.bassVal);
                this.bassCurve.push({ id: Date.now(), vol: currentVol, bass: currentBass });
                this.bassCurve.sort((a,b) => a.vol - b.vol);
                this.renderCurveNodes();
                this.saveBassCurve();
            }

            addCurveNodeBlank() {
                const defaultVol = this.gain ? Math.round(this.gain.gain.value * 100) : 50;
                this.bassCurve.push({ id: Date.now(), vol: defaultVol, bass: 0 });
                this.bassCurve.sort((a,b) => a.vol - b.vol);
                this.renderCurveNodes();
                this.saveBassCurve();
            }

            removeCurveNode(id) {
                this.bassCurve = this.bassCurve.filter(n => n.id !== id);
                this.renderCurveNodes();
                this.saveBassCurve();
            }

            updateCurveNode(id, key, val) {
                const node = this.bassCurve.find(n => n.id === id);
                if(node) {
                    node[key] = parseFloat(val) || 0;
                    this.bassCurve.sort((a,b) => a.vol - b.vol);
                    this.renderCurveNodes();
                    this.saveBassCurve();
                }
            }

            renderCurveNodes() {
                const container = window.$('bassCurveNodes');
                if(!container) return;
                
                if(!this.bassCurve || this.bassCurve.length === 0) {
                    container.innerHTML = '<div class="text-center text-[10px] text-white/30 font-bold py-2">No points mapped. Add a node below.</div>';
                    return;
                }
                
                let html = '';
                this.bassCurve.forEach((node, index) => {
                    html += `
                        <div class="flex items-center justify-between bg-white/5 border border-white/5 rounded-[24px] py-1.5 px-2 z-10 relative shadow-lg my-1 mx-2">
                            
                            <!-- Vol Pill (Sticks out left) -->
                            <div class="flex items-center bg-black/90 rounded-full px-3 py-2 -ml-5 shadow-[0_0_15px_rgba(255,255,255,0.15)] border border-white/20 z-20 hover:scale-105 transition-transform">
                                <i class="fa-solid fa-volume-high text-[11px] text-white/50"></i>
                                <input type="number" class="w-8 bg-transparent text-[13px] text-center font-black text-white outline-none ml-1 placeholder-white/30" value="${node.vol}" onchange="window.audioSys.updateCurveNode(${node.id}, 'vol', this.value)" min="0" max="100">
                                <span class="text-white/50 font-bold text-[10px]">%</span>
                            </div>

                            <span class="text-white/20 font-black text-[14px] mx-1 opacity-50">=</span>

                            <!-- Bass Pill (Sticks out right) -->
                            <div class="flex items-center bg-gradient-to-r from-purple-900/90 to-purple-800/90 rounded-full px-3 py-2 -mr-3 shadow-[0_0_20px_rgba(168,85,247,0.5)] border border-purple-400/50 z-20 hover:scale-105 transition-transform">
                                <i class="fa-solid fa-burst text-[11px] text-purple-300"></i>
                                <input type="number" class="w-7 bg-transparent text-[13px] text-center font-black text-white outline-none ml-1 placeholder-purple-300/30" value="${node.bass}" onchange="window.audioSys.updateCurveNode(${node.id}, 'bass', this.value)" min="-10" max="40">
                                <span class="text-purple-300 font-black text-[10px]">dB</span>
                            </div>

                            <!-- Delete Badge -->
                            <button onclick="window.audioSys.removeCurveNode(${node.id})" class="absolute -right-1 -top-1 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center hover:scale-125 hover:bg-red-400 transition-transform shadow-[0_0_10px_rgba(239,68,68,0.8)] z-30">
                                <i class="fa-solid fa-xmark text-[10px]"></i>
                            </button>
                        </div>
                    `;
                    if (index < this.bassCurve.length - 1) {
                        html += `
                            <div class="flex justify-center -my-2 relative z-0">
                                <div class="w-px h-4 bg-white/10"></div>
                            </div>
                        `;
                    }
                });
                container.innerHTML = html;
            }

            updateDynamicBass() {
                if(!this.ctx || !this.gain || !this.bass) return;
                const volPct = this.gain.gain.value * 100;
                
                let targetBass = parseInt(this.bassVal || 0);

                if (this.curveEnabled && this.bassCurve && this.bassCurve.length > 0) {
                    if (this.bassCurve.length === 1) {
                        targetBass = this.bassCurve[0].bass;
                    } else if (volPct <= this.bassCurve[0].vol) {
                        targetBass = this.bassCurve[0].bass;
                    } else if (volPct >= this.bassCurve[this.bassCurve.length - 1].vol) {
                        targetBass = this.bassCurve[this.bassCurve.length - 1].bass;
                    } else {
                        // Linear interpolation between points
                        for (let i = 0; i < this.bassCurve.length - 1; i++) {
                            const p1 = this.bassCurve[i];
                            const p2 = this.bassCurve[i + 1];
                            if (volPct >= p1.vol && volPct <= p2.vol) {
                                const t = (volPct - p1.vol) / (p2.vol - p1.vol);
                                targetBass = p1.bass + t * (p2.bass - p1.bass);
                                break;
                            }
                        }
                    }
                }

                if(this.xtremeOn) targetBass += 5;
                
                if(this.bass.gain.setTargetAtTime) {
                    this.bass.gain.setTargetAtTime(targetBass, this.ctx.currentTime, 0.1);
                } else {
                    this.bass.gain.value = targetBass;
                }
            }
            
            setBass(v){
                this.bassVal=v; window.$('bassVal').innerText=`+${v}dB`; 
                this.updateDynamicBass();
                if(this.globalAudio) localStorage.setItem('sv_bass',v);
                else if(window.player && window.player.currentTrack) { window.player.currentTrack.bassVal=v; window.player.db.update(window.player.currentTrack.id, {bassVal:v}); }
                if(window.ui && window.ui.updateMetaTags) window.ui.updateMetaTags();
                this.broadcastFx();
            }
            setReverb(v){
                if(this.ctx)this.revGain.gain.value=v/50; this.reverbVal=v; window.$('reverbVal').innerText=v+'%'; 
                if(this.globalAudio) localStorage.setItem('sv_reverb',v);
                else if(window.player && window.player.currentTrack) { window.player.currentTrack.reverbVal=v; window.player.db.update(window.player.currentTrack.id, {reverbVal:v}); }
                if(window.ui && window.ui.updateMetaTags) window.ui.updateMetaTags();
                this.broadcastFx();
            }
            setVolume(v){
                if(this.ctx)this.gain.gain.value=v;
                const sl = document.querySelector('.vol-slider');
                // The slider is rotated 270deg, so left-to-right is bottom-to-top visually.
                if(sl) sl.style.background = `linear-gradient(to right, #ff2a2a ${v*100}%, rgba(255,255,255,0.1) ${v*100}%)`;
                this.updateDynamicBass();
                
                if(this.volAnim) this.volAnim.animateTo(v);
            }
            
            setVolFromTextInput(v) {
                let parsed = parseFloat(v.replace('%', ''));
                if(isNaN(parsed)) parsed = 100;
                parsed = Math.max(0, Math.min(200, parsed));
                const normalized = parsed / 100;
                let slider = document.querySelector('.vol-slider');
                if(slider) {
                    slider.value = normalized;
                    this.setVolume(normalized);
                }
                const display = window.$('volPercentDisplay');
                if(display) {
                    display.value = parsed + '%';
                    display.blur();
                }
            }
            
            setBaseSpeed(v){
                this.baseSpeed=parseFloat(v); window.$('pitchVal').innerText=v+"x"; 
                if(this.globalAudio) localStorage.setItem('sv_pitch',v);
                else if(window.player && window.player.currentTrack) { window.player.currentTrack.baseSpeed=parseFloat(v); window.player.db.update(window.player.currentTrack.id, {baseSpeed:parseFloat(v)}); }
                if(window.ui && window.ui.updateMetaTags) window.ui.updateMetaTags();
                this.broadcastFx();
            }
            toggleXtreme(){
                const on=window.$('xtremeToggle').checked; this.xtremeOn = on;
                if(this.ctx){this.bass.type=on?"peaking":"lowshelf"; this.bass.frequency.value=on?60:200; this.bass.Q.value=on?1.5:1;}
                this.updateDynamicBass();
                if(this.globalAudio) localStorage.setItem('sv_xtreme',on);
                else if(window.player && window.player.currentTrack) { window.player.currentTrack.xtremeOn=on; window.player.db.update(window.player.currentTrack.id, {xtremeOn:on}); }
                this.broadcastFx();
            }
            applyPreset(type) {
                let bass = 0, rev = 0;
                switch(type) {
                    case 'electronic': bass = 12; rev = 15; break;
                    case 'acoustic': bass = 2; rev = 30; break;
                    case 'bass_boost': bass = 30; rev = 0; break;
                    case 'vocal': bass = -5; rev = 10; break;
                    case 'flat': bass = 0; rev = 0; break;
                }
                document.querySelectorAll('.setting-slider')[1].value = bass;
                document.querySelectorAll('.setting-slider')[2].value = rev;
                this.setBass(bass);
                this.setReverb(rev);
            }
            
            broadcastFx() {
                if(window.partyMode && window.partyMode.active && window.partyMode.isHost && window.partyMode.hostFxOverride) {
                    window.partyMode.broadcast({
                        type: 'FX_SYNC',
                        bass: this.bassVal,
                        reverb: this.reverbVal,
                        speed: this.baseSpeed,
                        xtreme: this.xtremeOn
                    });
                }
            }
        };

        class HistoryBuffer {
            constructor(frames, binCount) {
                this.maxFrames = frames;
                this.head = 0;
                this.buffer = Array.from({ length: frames }, () => new Uint8Array(binCount));
            }
            update(analyser) {
                this.head = (this.head + 1) % this.maxFrames;
                analyser.getByteFrequencyData(this.buffer[this.head]);
            }
            getDelayedFrame(framesAgo) {
                let index = (this.head - framesAgo) % this.maxFrames;
                if (index < 0) index += this.maxFrames;
                return this.buffer[index];
            }
        }

        class Visualizer {
            constructor() { 
                this.cv=window.$('vizCanvas'); 
                this.ctx=this.cv.getContext('2d'); 
                this.mode='ring'; 
                this.smooth=true; 
                this.flash=true; 
                this.rippleEffect=true;
                
                // Temporal Ghosting Variables
                this.history = new HistoryBuffer(30, 1024);
                this.isGhostingEnabled = true;
                this.exponent = 3; // Softer exponent for smooth thick horns
                this.liquidBinCount = 48; // Number of bins to analyze for Liquid mode
                this.resize(); 
                window.addEventListener('resize',()=>this.resize()); 
                this.xMode = false;
                this.xStrength = 0;
                this.lastTrigger = 0; 
                this.lastRippleTime = 0;
                this.bassHistory = [];
            }
            resize(){ this.cv.width=window.innerWidth; this.cv.height=window.innerHeight; }
            start(){ this.draw(); }
            toggleMode(){ 
                if (this.mode === 'ring') this.mode = 'bar';
                else if (this.mode === 'bar') this.mode = 'liquid';
                else this.mode = 'ring';
                window.$('vizModeBtn').innerText=this.mode.toUpperCase(); 
                window.$('albumArt').className=`album-art glass-panel ${(this.mode==='ring' || this.mode==='liquid')?'circle':''}`; 
                
                // Update Liquid Lines UI Toggle
                const linesToggleLabel = window.$('liquidLinesToggle')?.previousElementSibling; // Span is before input
                
                // Let's do it safely
                const spans = document.querySelectorAll('span');
                let targetSpan = null;
                for(let s of spans) {
                    if(s.innerText.includes('Liquid Lines') || s.innerText.includes('Smooth Following')) {
                        targetSpan = s; break;
                    }
                }
                
                if (targetSpan) {
                    if (this.mode === 'liquid') {
                        targetSpan.innerText = 'Smooth Following';
                    } else {
                        targetSpan.innerText = 'Liquid Lines';
                    }
                }
            }
            clearFlash(){ window.$('beat-flash').style.opacity=0; }
            triggerXEffect(intensity = 1.0){ 
                this.xMode = true; 
                this.xStrength = intensity; 
                this.xLobeShape = Math.floor(Math.random() * 4) + 1; // 1 to 4 lobes (line, triangle, cross, pentagon)
                this.xLobePhase = Math.random() < 0.5 ? 0 : Math.PI/4; // Rotate the shapes 45 degrees
                setTimeout(() => this.xMode = false, 300); 
            }
            getCP(x0,y0,x1,y1,x2,y2){ const t=0.4, d1=Math.hypot(x1-x0,y1-y0), d2=Math.hypot(x2-x1,y2-y1), fa=t*d1/(d1+d2), fb=t*d2/(d1+d2); return [x1-fa*(x2-x0),y1-fa*(y2-y0),x1+fb*(x2-x0),y1+fb*(y2-y0)]; }
            draw(){
                requestAnimationFrame(()=>this.draw()); 
                const t = window.audioSys.audio.currentTime;
                if(t < this.lastTrigger) this.lastTrigger = -1; 
                if(window.player && window.player.currentTrack && !window.audioSys.audio.paused) {
                    if (window.player.currentTrack.beatSignals) {
                        const hit = window.player.currentTrack.beatSignals.some(bt => Math.abs(bt - t) < 0.05);
                        if(hit && (Math.abs(t - this.lastTrigger) > 0.2)) {
                            this.triggerXEffect(1.0); this.lastTrigger = t; if (navigator.vibrate) navigator.vibrate(50);
                        }
                    }
                }
                if(!window.audioSys.analyser)return;
                
                // Update History Buffer BEFORE reading the active frame
                this.history.update(window.audioSys.analyser);
                
                const buf=new Uint8Array(window.audioSys.analyser.frequencyBinCount); window.audioSys.analyser.getByteFrequencyData(buf);
                const ctx=this.ctx, w=this.cv.width, h=this.cv.height; 
                if(this.xStrength > 0) this.xStrength -= 0.05; if(this.xStrength < 0) this.xStrength = 0;
                const baseZoom = window.displayScale || 1.0;
                const shake = this.xStrength * 60 * baseZoom; const zoom = baseZoom + (this.xStrength * 0.15 * baseZoom); const rot = (Math.random() - 0.5) * this.xStrength * 0.25; 
                ctx.save(); ctx.translate(w/2, h/2); ctx.scale(zoom, zoom); ctx.rotate(rot); ctx.translate(-w/2 + (Math.random()-0.5)*shake, -h/2 + (Math.random()-0.5)*shake);
                if(this.xStrength > 0.1) {
                     const flashAlpha = Math.min(0.8, this.xStrength * 0.2);
                     ctx.fillStyle = `rgba(255, 255, 255, ${flashAlpha})`; ctx.fillRect(-w, -h, w*3, h*3); 
                }
                ctx.clearRect(-w, -h, w*3, h*3);
                const sens = window.vizSens || 1.0;
                let bass=0; for(let i=0;i<4;i++)bass+=buf[i]*sens; bass/=4;
                if(this.flash){ 
                    const th=120; 
                    if(bass>th){const int=(bass-th)/(255-th); window.$('beat-flash').style.opacity=int*0.7;}else window.$('beat-flash').style.opacity=0; 
                    window.$('beat-flash').style.transform = `translate(-50%, -50%) scale(${baseZoom})`;
                }
                
                // Bass Reactive Background
                const bgLayer = window.$('bg-layer');
                const isMobile = window.innerWidth < 800 || window.innerHeight < 600 || /Mobi|Android/i.test(navigator.userAgent);
                if (bgLayer) {
                     const baseOp = parseFloat(localStorage.getItem('sv_bg_bright') || 0.15);
                     if (bass > 100) {
                          const bgInt = (bass-100)/(255-100);
                          bgLayer.style.opacity = Math.min(1, baseOp + bgInt * 0.4);
                          bgLayer.style.filter = isMobile ? 'none' : `blur(30px) brightness(${1 + bgInt * 0.5})`;
                     } else {
                          bgLayer.style.opacity = baseOp;
                          bgLayer.style.filter = isMobile ? 'none' : `blur(30px) brightness(1)`;
                     }
                }
                
                // Bass Ripple Effect (Attack/Transient rate-of-change detection)
                this.bassHistory.push(bass);
                if(this.bassHistory.length > 5) this.bassHistory.shift();
                const prevBass = this.bassHistory[this.bassHistory.length - 2] || bass;
                const bassJump = bass - prevBass; // dC/dt
                
                if (this.rippleEffect && bass > 180 && bassJump > 30 && (performance.now() - this.lastRippleTime > 300)) {
                    this.lastRippleTime = performance.now();
                    const ripple = document.createElement('div');
                    ripple.className = 'bass-ripple';
                    document.body.appendChild(ripple);
                    setTimeout(() => ripple.remove(), 1000);
                }

                const te=buf.reduce((a,b)=>a+b,0); 
                if(te > 100) { 
                    if(this.mode==='ring') this.drawRing(ctx,w,h,buf); 
                    else if(this.mode==='liquid') this.drawLiquid(ctx,w,h,buf);
                    else this.drawBars(ctx,w,h,buf); 
                }
                ctx.restore();
            }
            drawRing(ctx,w,h,d){
                const art = document.getElementById('albumArt');
                let cx = w/2, cy = h/2 - 40;
                if(art) { const rect = art.getBoundingClientRect(); cx = rect.left + rect.width/2; cy = rect.top + rect.height/2; }
                const r=140, bars=100;
                // IMPROVED: Use a wider range of the buffer to avoid static/dead lines
                const lim=Math.floor(d.length * 0.6), step=Math.max(1, Math.floor(lim/bars));
                const sens = window.vizSens || 1.0;
                const col=getComputedStyle(document.documentElement).getPropertyValue('--accent');
                const isMobile = window.innerWidth < 800 || window.innerHeight < 600 || /Mobi|Android/i.test(navigator.userAgent);
                if(this.xStrength > 0.2) { ctx.strokeStyle = "#ffffff"; ctx.shadowColor = "#ffffff"; } else { ctx.strokeStyle=col; ctx.shadowColor=col; }
                ctx.lineWidth=3 + (this.xStrength * 5); ctx.lineCap='round'; ctx.shadowBlur= isMobile ? 0 : 15 + (this.xStrength * 30);
                const pts=[]; 
                for(let i=0;i<bars;i++){ 
                    const idx=Math.floor(i*step), v=d[idx]*sens, val=v*1.5, ang=(i/bars)*Math.PI*2; 
                    let x = cx+Math.cos(ang)*(r+val); let y = cy+Math.sin(ang)*(r+val);
                    if(this.xStrength > 0.01) {
                        const rad = (i/bars) * Math.PI * 2; 
                        const lobeCount = this.xLobeShape || 2;
                        const phase = this.xLobePhase || Math.PI/4;
                        const lobe = Math.sin(rad * lobeCount + phase); 
                        const distortion = lobe > 0 ? lobe * 30 : lobe * 120; 
                        const dist = this.xStrength * distortion;
                        x = cx + Math.cos(ang) * (r + val + dist); 
                        y = cy + Math.sin(ang) * (r + val + dist);
                    }
                    pts.push({x: x|0, y: y|0}); 
                } 
                pts.push(pts[0],pts[1]); 
                
                const path = new Path2D();
                if(this.smooth){ 
                    path.moveTo(pts[0].x,pts[0].y); 
                    for(let i=1;i<pts.length-2;i++){ 
                        const p0=pts[i-1], p1=pts[i], p2=pts[i+1];
                        const cp1 = this.getCP(p0.x,p0.y,p1.x,p1.y,p2.x,p2.y);
                        const cp2 = this.getCP(p1.x,p1.y,p2.x,p2.y,pts[i+2].x,pts[i+2].y);
                        path.bezierCurveTo(cp1[2]|0, cp1[3]|0, cp2[0]|0, cp2[1]|0, p2.x, p2.y); 
                    } 
                    ctx.stroke(path); 
                } else { 
                    for(let i=0;i<bars;i++){ 
                        const ang=(i/bars)*Math.PI*2, idx=Math.floor(i*step), x=cx+Math.cos(ang)*(r+d[idx]*sens*1.5), y=cy+Math.sin(ang)*(r+d[idx]*sens*1.5); 
                        path.moveTo((cx+Math.cos(ang)*r)|0,(cy+Math.sin(ang)*r)|0); path.lineTo(x|0,y|0); 
                    } 
                    ctx.stroke(path); 
                }
            }
            drawBars(ctx,w,h,d){
                const cnt=100, sp=w/cnt;
                const lim=Math.floor(d.length * 0.6), step=Math.max(1, Math.floor(lim/cnt));
                const sens = window.vizSens || 1.0;
                const isMobile = window.innerWidth < 800 || window.innerHeight < 600 || /Mobi|Android/i.test(navigator.userAgent);
                const col=getComputedStyle(document.documentElement).getPropertyValue('--accent'); ctx.fillStyle=col; ctx.shadowBlur=isMobile ? 0 : 10; ctx.shadowColor=col;
                const path = new Path2D();
                if(this.smooth){ 
                    path.moveTo(0,h); 
                    for(let i=0;i<cnt;i++){ 
                        const idx=Math.floor(i*step), v=d[idx]*sens, y=h-(v/255)*(h*0.8), x=i*sp+sp/2; 
                        if(i===0) path.lineTo(x|0,y|0); 
                        else { 
                            const pi=Math.floor((i-1)*step), px=(i-1)*sp+sp/2, py=h-(d[pi]*sens/255)*(h*0.8); 
                            path.quadraticCurveTo(px|0, py|0, ((px+x)/2)|0, ((py+y)/2)|0); 
                        } 
                    } 
                    path.lineTo(w,h); 
                    ctx.fill(path); 
                } else { 
                    for(let i=0;i<cnt;i++){ 
                        const idx=Math.floor(i*step), v=d[idx]*sens, bh=(v/255)*(h*0.8); 
                        path.rect((i*sp)|0, (h-bh)|0, (Math.max(1, sp-2))|0, bh|0); 
                    } 
                    ctx.fill(path);
                }
            }
buildSmoothPath(points) {
                const path = new Path2D();
                const len = points.length;
                if (len < 3) return path;

                path.moveTo(points[0].x, points[0].y);
                const tension = 1.0;

                for (let i = 0; i < len; i++) {
                    const p0 = points[(i - 1 + len) % len];
                    const p1 = points[i];
                    const p2 = points[(i + 1) % len];
                    const p3 = points[(i + 2) % len];

                    const cp1x = p1.x + (p2.x - p0.x) * (tension / 6);
                    const cp1y = p1.y + (p2.y - p0.y) * (tension / 6);
                    const cp2x = p2.x - (p3.x - p1.x) * (tension / 6);
                    const cp2y = p2.y - (p3.y - p1.y) * (tension / 6);

                    path.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
                }
                path.closePath();
                return path;
            }

            drawLiquid(ctx, w, h, d) {
                const art = document.getElementById('albumArt');
                let cx = w/2, cy = h/2 - 40;
                if(art) { const rect = art.getBoundingClientRect(); cx = rect.left + rect.width/2; cy = rect.top + rect.height/2; }
                
                // Audio Energy Buckets
                let bassAvg = 0, midAvg = 0, highAvg = 0;
                for(let k=0; k<6; k++) bassAvg += d[k] || 0;
                for(let k=10; k<20; k++) midAvg += d[k] || 0;
                for(let k=24; k<40; k++) highAvg += d[k] || 0;
                
                // Normalized Intensities
                let bassIntensity = Math.min(1.5, (bassAvg / 6) / 200.0);
                let midIntensity = Math.min(1.5, (midAvg / 10) / 150.0);
                let highIntensity = Math.min(1.5, (highAvg / 16) / 100.0);

                const sens = window.vizSens || 1.0;
                bassIntensity *= sens; midIntensity *= sens; highIntensity *= sens;

                const time = performance.now() / 1000.0;
                const baseRad = 100;
                
                const drawBlob = (color, intensity, sParams, nodes, stretch) => {
                    const points = [];
                    for(let i=0; i<nodes; i++) {
                        const angle = (i / nodes) * Math.PI * 2;
                        
                        // Perlin-style cyclic noise using sum of sines
                        const flow1 = Math.sin(angle * sParams.f1 + time * sParams.s1);
                        const flow2 = Math.cos(angle * sParams.f2 - time * sParams.s2);
                        const flow3 = Math.sin(angle * sParams.f3 + time * sParams.s3);
                        const noise = (flow1 + flow2 + flow3) / 3.0;
                        
                        // The fluid expands organically
                        const dynamicExpansion = intensity * stretch * (0.6 + 0.4 * noise);
                        const r = baseRad + dynamicExpansion;
                        
                        points.push({ x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) });
                    }
                    const path = this.buildSmoothPath(points);
                    ctx.fillStyle = color;
                    ctx.fill(path);
                };

                // Blend mode for overlapping liquids
                ctx.globalCompositeOperation = 'screen';

                if(this.smooth) {
                    // PURPLE HILL (Highs) - Fast, spiky, jittery
                    drawBlob('rgba(168, 85, 247, 0.6)', highIntensity, {f1: 4, s1: 2.0, f2: 5, s2: 3.1, f3: 7, s3: 1.5}, 64, 80);
                    
                    // YELLOW HILL (Mids) - Medium smooth waves
                    drawBlob('rgba(234, 179, 8, 0.7)', midIntensity, {f1: 3, s1: 1.2, f2: 4, s2: 1.5, f3: 5, s3: 1.1}, 64, 120);
                    
                    // GREEN HILL (Bass) - Slow, wide, massive fluid blobs
                    drawBlob('rgba(34, 197, 94, 0.8)', Math.pow(bassIntensity, 1.2), {f1: 2, s1: 0.6, f2: 3, s2: 0.8, f3: 4, s3: 0.5}, 64, 200);
                }

                // ACCENT CORE (Solid backplate wrapping the album art)
                ctx.globalCompositeOperation = 'source-over';
                const tMode = window.ui ? window.ui.themeMode : 'solid';
                const acc = (tMode === 'solid-fill') 
                             ? (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#ef4444')
                             : '#ffffff';
                             
                drawBlob(acc, Math.pow(bassIntensity, 0.8), {f1: 2, s1: 1.0, f2: 2, s2: -1.0, f3: 3, s3: 0.0}, 64, 25);
            }
        };

        class CurveEditor {
            constructor() { 
                this.cv = window.$('curveCanvas');
                this.ctx = this.cv.getContext('2d'); 
                
                this.move = this.move.bind(this);
                this.down = this.down.bind(this);
                this.up = this.up.bind(this);

                this.pts = [{x:0,y:0.5},{x:1,y:0.5}]; 
                this.beatSignals = [];
                this.triggers = []; 
                this.presets = JSON.parse(localStorage.getItem('sv_presets'))||[{name:"Normal",pts:[{x:0,y:0.5},{x:1,y:0.5}]},{name:"Slowed",pts:[{x:0,y:0.2},{x:1,y:0.2}]},{name:"Nightcore",pts:[{x:0,y:0.8},{x:1,y:0.8}]}]; 
                
                this.history = [];
                this.redoStack = [];
                this.clipboard = null;

                this.selectedBeats = new Set(); 
                this.isSelecting = false;
                this.selectionStart = null; 
                this.selectionRect = null; 
                this.dragStartBeats = null; 
                this.dragStartMouse = 0; 

                this.drag = -1; 
                this.dragType = null; 
                this.activeTrigger = null;
                this.zoom = 1.0;
                this.verticalZoom = 1.0;
                this.viewOffset = 0; 
                this.mouseX = 0;
                this.editMode = 'speed'; 
                this.waveform = null;
                this.isQPressed = false;
                this.isDPressed = false;
                this.isDraggingPlayhead = false;
                this.isPanning = false;
                this.lastMouseX = 0;
                this.animId = null;
                this.tiltEnabled = false;
                
                this.tempBeats = null;
                this.prevBeats = null;
                this.scanMinGap = 0.1;

                this.cv.addEventListener('mousedown', this.down);
                window.addEventListener('mousemove', this.move); 
                window.addEventListener('mouseup', this.up); 
                this.cv.addEventListener('dblclick', e => this.dbl(e));
                
                window.addEventListener('keydown', e => {
                    if (e.target.tagName === 'INPUT') return;
                    if (e.key.toLowerCase() === 'q') { this.isQPressed = true; this.cv.classList.add('cursor-grab'); }
                    if (e.key.toLowerCase() === 'd') { this.isDPressed = true; this.cv.classList.add('cursor-delete'); }
                    if (e.key === 'Shift') this.cv.style.cursor = 'grab';
                    
                    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); this.undo(); }
                    if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); this.redo(); }
                    if ((e.ctrlKey || e.metaKey) && e.key === 'c') { e.preventDefault(); this.copy(); }
                    if ((e.ctrlKey || e.metaKey) && e.key === 'v') { e.preventDefault(); this.paste(); }
                    if (e.key === 'Delete' || e.key === 'Backspace') { this.deleteSelected(); }
                });
                window.addEventListener('keyup', e => {
                    if (e.key.toLowerCase() === 'q') { this.isQPressed = false; this.cv.classList.remove('cursor-grab'); this.isDraggingPlayhead = false; }
                    if (e.key.toLowerCase() === 'd') { this.isDPressed = false; this.cv.classList.remove('cursor-delete'); }
                    if (e.key === 'Shift') this.cv.style.cursor = 'crosshair';
                });
                
                this.cv.addEventListener('wheel', e => { 
                    e.preventDefault(); 
                    const duration = window.audioSys.audio.duration || 100;
                    if (e.shiftKey) {
                        const scrollAmount = (e.deltaY > 0 ? 1 : -1) * (duration / this.zoom / 20);
                        this.viewOffset = Math.max(0, Math.min(this.viewOffset + scrollAmount, duration - (duration / this.zoom)));
                    } else {
                        const rect = this.cv.getBoundingClientRect();
                        const scaleX = this.cv.width / rect.width;
                        const mouseX = (e.clientX - rect.left) * scaleX;
                        const timeAtMouse = this.xToTime(mouseX);
                        const oldZoom = this.zoom;
                        this.setZoom(Math.max(1, Math.min(20, this.zoom + (e.deltaY < 0 ? 0.5 : -0.5))));
                        if (this.zoom !== oldZoom) {
                            const newVisibleDur = duration / this.zoom;
                            this.viewOffset = Math.max(0, timeAtMouse - (mouseX / this.cv.width * newVisibleDur));
                        }
                    }
                });

                this.rendPre(); 
            }
            
            get isOpen() { return window.$('curveEditor').style.opacity === '1'; }

            saveState() {
                const state = {
                    beatSignals: [...this.beatSignals],
                    triggers: JSON.parse(JSON.stringify(this.triggers)),
                    speedPoints: JSON.parse(JSON.stringify(this.pts))
                };
                this.history.push(state);
                if(this.history.length > 50) this.history.shift();
                this.redoStack = []; 
            }

            undo() {
                if(this.history.length === 0) return;
                const currentState = {
                    beatSignals: [...this.beatSignals],
                    triggers: JSON.parse(JSON.stringify(this.triggers)),
                    speedPoints: JSON.parse(JSON.stringify(this.pts))
                };
                this.redoStack.push(currentState);
                const prevState = this.history.pop();
                this.applyState(prevState);
            }

            redo() {
                if(this.redoStack.length === 0) return;
                const currentState = {
                    beatSignals: [...this.beatSignals],
                    triggers: JSON.parse(JSON.stringify(this.triggers)),
                    speedPoints: JSON.parse(JSON.stringify(this.pts))
                };
                this.history.push(currentState);
                const nextState = this.redoStack.pop();
                this.applyState(nextState);
            }

            applyState(state) {
                this.beatSignals = state.beatSignals;
                this.triggers = state.triggers;
                this.pts = state.speedPoints;
                this.saveSignals();
            }

            copy() {
                if(this.selectedBeats.size === 0) return;
                const sorted = Array.from(this.selectedBeats).sort((a,b) => a-b);
                const anchor = sorted[0];
                this.clipboard = sorted.map(t => t - anchor);
            }

            paste() {
                if(!this.clipboard || this.editMode !== 'beat') return;
                this.saveState();
                const rect = this.cv.getBoundingClientRect();
                const mouseInside = this.mouseX >= 0 && this.mouseX <= this.cv.width;
                const anchorTime = mouseInside ? this.xToTime(this.mouseX) : window.audioSys.audio.currentTime;
                const newBeats = this.clipboard.map(dt => anchorTime + dt);
                this.selectedBeats.clear();
                newBeats.forEach(t => {
                    this.beatSignals.push(t);
                    this.selectedBeats.add(t);
                });
                this.beatSignals.sort((a,b) => a-b);
                this.saveSignals();
            }

            deleteSelected() {
                if(this.selectedBeats.size === 0) return;
                this.saveState();
                this.beatSignals = this.beatSignals.filter(t => !this.selectedBeats.has(t));
                this.selectedBeats.clear();
                this.saveSignals();
            }
            
            toggleTilt() {
                this.tiltEnabled = !this.tiltEnabled;
                const btn = window.$('tiltBtn');
                const icon = window.$('tiltIcon');
                if(this.tiltEnabled) {
                    btn.classList.add('active');
                    icon.className = 'fa-solid fa-link-slash';
                    btn.title = "Linked Handles (Flat Lines)";
                } else {
                    btn.classList.remove('active');
                    icon.className = 'fa-solid fa-link';
                    btn.title = "Unlink Handles (Tilt Lines)";
                }
            }

            open() {
                window.$('curveEditor').style.opacity = '1';
                window.$('curveEditor').style.pointerEvents = 'auto'; 
                if(window.player.currentTrack) {
                    this.beatSignals = window.player.currentTrack.beatSignals || [];
                    this.triggers = window.player.currentTrack.triggers || [];
                    if(window.player.currentTrack.speedPoints) this.pts = window.player.currentTrack.speedPoints;
                    this.loadWaveform(); 
                }
                this.setMode('beat'); 
                this.startLoop();
            } 

            close() {
                window.$('curveEditor').style.opacity = '0';
                window.$('curveEditor').style.pointerEvents = 'none';
                cancelAnimationFrame(this.animId);
            }

            startLoop() {
                const loop = () => {
                    if(!this.isOpen) return;
                    this.draw(); 
                    this.animId = requestAnimationFrame(loop);
                };
                loop();
            }

            async loadWaveform() {
                if(!window.player.currentTrack || !window.player.currentTrack.blob) return;
                this.waveform = null;
                try {
                    if(!window.audioSys.ctx) window.audioSys.init();
                    const arrayBuffer = await window.player.currentTrack.blob.arrayBuffer();
                    const audioBuffer = await window.audioSys.ctx.decodeAudioData(arrayBuffer);
                    this.waveform = audioBuffer.getChannelData(0); 
                } catch(e) {}
            }

            setMode(mode) {
                this.editMode = mode;
                window.$('btnModeSpeed').classList.remove('active');
                window.$('btnModeBeat').classList.remove('active');
                window.$('btnModeTrigger').classList.remove('active');
                window.$('scanBtn').style.display = 'none';
                window.$('editorHint').innerText = "";

                if (mode === 'speed') {
                    window.$('btnModeSpeed').classList.add('active');
                    window.$('editorHint').innerText = "Speed: Click line to add point (Q: Seek, D: Delete)";
                } else if (mode === 'beat') {
                    window.$('btnModeBeat').classList.add('active');
                    window.$('editorHint').innerText = "Beat: Drag to Box Select. Ctrl+C/V to Copy/Paste. Ctrl+Z/B to Undo/Redo.";
                } else if (mode === 'trigger') {
                    window.$('btnModeTrigger').classList.add('active');
                    window.$('editorHint').innerText = "Trigger: Drag green areas. Click SCAN to auto-mark beats.";
                    window.$('scanBtn').style.display = 'block';
                }
                this.selectedBeats.clear();
            }
            
            setZoom(z) { this.zoom = parseFloat(z); }
            setVerticalZoom(z) { this.verticalZoom = parseFloat(z); }

            xToTime(x) {
                const duration = window.audioSys.audio.duration || 100;
                const visibleDur = duration / this.zoom;
                return (x / this.cv.width) * visibleDur + this.viewOffset;
            }
            
            timeToX(t) {
                const duration = window.audioSys.audio.duration || 100;
                const visibleDur = duration / this.zoom;
                return ((t - this.viewOffset) / visibleDur) * this.cv.width;
            }

            updateCursor() {
                const el = window.$('timelineCursor');
                el.style.display = 'block';
                const rect = this.cv.getBoundingClientRect();
                const cssX = (this.mouseX / this.cv.width) * rect.width;
                el.style.left = cssX + 'px';
                
                if(this.isDPressed) {
                     el.style.background = '#ef4444'; 
                     window.$('cursorTime').style.background = '#ef4444';
                     window.$('cursorTime').innerText = "ERASER";
                } else {
                     el.style.background = 'rgba(255,255,255,0.5)';
                     window.$('cursorTime').style.background = 'rgba(255,255,255,0.1)';
                     const time = this.xToTime(this.mouseX);
                     const ms = Math.floor((time % 1) * 100);
                     const s = Math.floor(time % 60);
                     const m = Math.floor(time / 60);
                     window.$('cursorTime').innerText = `${m}:${s < 10 ? '0'+s : s}.${ms < 10 ? '0'+ms : ms}`;
                }
            }

            getPos(e) {
                const r = this.cv.getBoundingClientRect();
                const scaleX = this.cv.width / r.width;
                const scaleY = this.cv.height / r.height;
                return {
                    x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), 
                    y: Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)),
                    realX: (e.clientX - r.left) * scaleX,
                    realY: (e.clientY - r.top) * scaleY
                };
            }

            down(e) {
                const p = this.getPos(e);
                if (e.shiftKey || e.button === 1) {
                    this.isPanning = true;
                    this.lastMouseX = p.realX;
                    this.cv.style.cursor = 'grabbing';
                    return;
                }
                if (this.isQPressed) {
                    this.isDraggingPlayhead = true;
                    this.seekToMouse(p.realX);
                    return;
                }
                if (this.isDPressed) {
                    this.deleteAtCursor(p.realX);
                    return;
                }
                const time = this.xToTime(p.realX);
                const duration = window.audioSys.audio.duration || 100;
                this.saveState(); 

                if (this.editMode === 'speed') {
                    const h = this.pts.findIndex(pt => {
                        const ptX = this.timeToX(pt.x * duration);
                        const ptY = (1-pt.y) * this.cv.height;
                        return Math.hypot(ptX - p.realX, ptY - p.realY) < 15;
                    });
                    if(h !== -1) { this.drag = h; this.dragType = 'point'; }
                    else { this.pts.push({x: time/duration, y: 1 - (p.realY / this.cv.height)}); }
                } 
                else if (this.editMode === 'beat') {
                    if (this.dragType === 'move_beats') {
                        const duration = window.audioSys.audio.duration || 100;
                        const visibleDur = duration / this.zoom;
                        const timeDelta = ((p.realX - this.dragStartMouse) / this.cv.width) * visibleDur;
                        
                        const staticBeats = this.beatSignals.filter(t => !this.selectedBeats.has(t));
                        const currentMovedBeats = [];
                        const nextSelection = new Set();
                        
                        this.dragStartBeats.forEach(orig => {
                            let nt = orig + timeDelta;
                            if(nt < 0) nt = 0;
                            currentMovedBeats.push(nt);
                            nextSelection.add(nt);
                        });
                        
                        this.beatSignals = [...staticBeats, ...currentMovedBeats].sort((a,b) => a-b);
                        this.selectedBeats = nextSelection;
                    }
                }
                else if (this.editMode === 'trigger') {
                    const hit = this.findTriggerAt(p.realX, p.realY);
                    if (hit) {
                        this.activeTrigger = hit.trigger;
                        this.dragType = hit.type; 
                        if(this.activeTrigger.startLevel === undefined) this.activeTrigger.startLevel = this.activeTrigger.level;
                        if(this.activeTrigger.endLevel === undefined) this.activeTrigger.endLevel = this.activeTrigger.level;
                    } else {
                        const h = this.cv.height;
                        let rawLevel = ((h/2) - p.realY) / (h/2);
                        if(rawLevel < 0.05) rawLevel = 0.05;
                        if(rawLevel > 1) rawLevel = 1;

                        const newTrig = { 
                            start: time, 
                            end: time + (duration/this.zoom)*0.1, 
                            level: rawLevel, 
                            startLevel: rawLevel, 
                            endLevel: rawLevel
                        }; 
                        this.triggers.push(newTrig);
                        this.activeTrigger = newTrig;
                        this.dragType = 'triggerRight'; 
                    }
                    this.saveSignals();
                }
            }

            findTriggerAt(mx, my) {
                const duration = window.audioSys.audio.duration || 100;
                const h = this.cv.height;
                const tol = 15; 
                for (let trig of this.triggers) {
                    const sx = this.timeToX(trig.start);
                    const ex = this.timeToX(trig.end);
                    const sL = trig.startLevel !== undefined ? trig.startLevel : trig.level;
                    const eL = trig.endLevel !== undefined ? trig.endLevel : trig.level;
                    const sy = (h/2) - (sL * h/2);
                    const ey = (h/2) - (eL * h/2);
                    if (Math.abs(mx - sx) < tol && Math.abs(my - sy) < tol) return { trigger: trig, type: 'triggerLeft' };
                    if (Math.abs(mx - ex) < tol && Math.abs(my - ey) < tol) return { trigger: trig, type: 'triggerRight' };
                    if (mx >= sx && mx <= ex) {
                        const t = (mx - sx) / (ex - sx);
                        const yAtX = sy + (ey - sy) * t;
                        if(Math.abs(my - yAtX) < tol) return { trigger: trig, type: 'trigger' };
                    }
                }
                return null;
            }

            move(e) {
                const p = this.getPos(e);
                if (this.isPanning) {
                    const deltaPx = this.lastMouseX - p.realX;
                    const duration = window.audioSys.audio.duration || 100;
                    const visibleDur = duration / this.zoom;
                    const deltaT = (deltaPx / this.cv.width) * visibleDur;
                    this.viewOffset = Math.max(0, Math.min(this.viewOffset + deltaT, duration - visibleDur));
                    this.lastMouseX = p.realX; return;
                }
                if (this.isDraggingPlayhead) { this.seekToMouse(p.realX); return; }
                if (this.isDPressed) { this.deleteAtCursor(p.realX); return; }
                if (this.isSelecting) {
                    const w = p.realX - this.selectionStart.x;
                    const h = p.realY - this.selectionStart.y;
                    this.selectionRect = { x: this.selectionStart.x, y: this.selectionStart.y, w, h }; return;
                }

                if (this.editMode === 'speed' && this.drag !== -1) {
                    const duration = window.audioSys.audio.duration || 100;
                    const time = this.xToTime(p.realX);
                    const yVal = 1 - (p.realY / this.cv.height);
                    if(this.drag === 0) this.pts[0].y = yVal; 
                    else if(this.drag === this.pts.length - 1) this.pts[this.pts.length - 1].y = yVal; 
                    else this.pts[this.drag] = {x: Math.max(0, Math.min(1, time/duration)), y: yVal};
                }
                else if (this.editMode === 'beat') {
                    if (this.dragType === 'move_beats') {
                        const duration = window.audioSys.audio.duration || 100;
                        const visibleDur = duration / this.zoom;
                        const timeDelta = ((p.realX - this.dragStartMouse) / this.cv.width) * visibleDur;
                        
                        const staticBeats = this.beatSignals.filter(t => !this.selectedBeats.has(t));
                        const currentMovedBeats = [];
                        const nextSelection = new Set();
                        
                        this.dragStartBeats.forEach(orig => {
                            let nt = orig + timeDelta;
                            if(nt < 0) nt = 0;
                            currentMovedBeats.push(nt);
                            nextSelection.add(nt);
                        });
                        
                        this.beatSignals = [...staticBeats, ...currentMovedBeats].sort((a,b) => a-b);
                        this.selectedBeats = nextSelection;
                    }
                }
                else if (this.editMode === 'trigger' && this.activeTrigger) {
                    const time = this.xToTime(p.realX);
                    const h = this.cv.height;
                    let rawLevel = ((h/2) - p.realY) / (h/2);
                    if (rawLevel < 0.05) rawLevel = 0.05; 
                    if (rawLevel > 1) rawLevel = 1;

                    if (this.dragType === 'trigger') {
                        const dur = this.activeTrigger.end - this.activeTrigger.start;
                        const mid = this.activeTrigger.start + dur/2;
                        const dt = time - mid;
                        this.activeTrigger.start += dt;
                        this.activeTrigger.end += dt;
                        this.activeTrigger.level = rawLevel; 
                        this.activeTrigger.startLevel = rawLevel;
                        this.activeTrigger.endLevel = rawLevel;
                    } else if (this.dragType === 'triggerLeft') {
                        this.activeTrigger.start = Math.min(time, this.activeTrigger.end - 0.1);
                        if(this.tiltEnabled) { this.activeTrigger.startLevel = rawLevel; } 
                        else { this.activeTrigger.level = rawLevel; this.activeTrigger.startLevel = rawLevel; this.activeTrigger.endLevel = rawLevel; }
                    } else if (this.dragType === 'triggerRight') {
                        this.activeTrigger.end = Math.max(time, this.activeTrigger.start + 0.1);
                        if(this.tiltEnabled) { this.activeTrigger.endLevel = rawLevel; } 
                        else { this.activeTrigger.level = rawLevel; this.activeTrigger.startLevel = rawLevel; this.activeTrigger.endLevel = rawLevel; }
                    }
                    this.saveSignals();
                }
            }

            up() {
                if (this.isSelecting) {
                    this.isSelecting = false;
                    const r = this.selectionRect;
                    if (!r || (Math.abs(r.w) < 5 && Math.abs(r.h) < 5)) {
                        this.selectedBeats.clear();
                        const time = this.xToTime(this.selectionStart.x);
                        this.beatSignals.push(time);
                        this.beatSignals.sort((a,b)=>a-b);
                        this.selectedBeats.add(time);
                    } else {
                        const x = r.w > 0 ? r.x : r.x + r.w;
                        const w = Math.abs(r.w);
                        const tStart = this.xToTime(x);
                        const tEnd = this.xToTime(x + w);
                        this.selectedBeats.clear();
                        this.beatSignals.forEach(t => {
                            if (t >= tStart && t <= tEnd) { this.selectedBeats.add(t); }
                        });
                    }
                    this.selectionRect = null;
                }
                if (this.dragType === 'move_beats') { this.saveSignals(); }
                this.drag = -1; this.activeTrigger = null; this.dragType = null; this.isDraggingPlayhead = false; this.isPanning = false; this.dragStartBeats = null;
            }
            
            deleteAtCursor(mouseX) {
                this.saveState();
                const duration = window.audioSys.audio.duration || 100;
                const cursorTime = this.xToTime(mouseX);
                const timeTolerance = (5 / this.cv.width) * (duration / this.zoom); 
                const initialBeats = this.beatSignals.length;
                this.beatSignals = this.beatSignals.filter(t => Math.abs(t - cursorTime) > timeTolerance);
                this.selectedBeats.forEach(t => { if (Math.abs(t - cursorTime) <= timeTolerance) this.selectedBeats.delete(t); });
                if(this.beatSignals.length !== initialBeats) this.saveSignals();
                if(this.editMode === 'speed') {
                    this.pts = this.pts.filter((pt, i) => {
                        if(i===0 || i===this.pts.length-1) return true;
                        const ptTime = pt.x * duration;
                        return Math.abs(ptTime - cursorTime) > timeTolerance;
                    });
                }
                if(this.editMode === 'trigger') {
                    this.triggers = this.triggers.filter(trig => !(cursorTime >= trig.start && cursorTime <= trig.end));
                    this.saveSignals();
                }
            }

            seekToMouse(x) {
                const dur = window.audioSys.audio.duration || 100;
                const time = this.xToTime(x);
                if(isFinite(time)) window.audioSys.audio.currentTime = Math.max(0, Math.min(time, dur));
            }

            dbl(e) {
                if (this.editMode === 'beat') {
                    const rect = this.cv.getBoundingClientRect();
                    const scaleX = this.cv.width / rect.width;
                    const mouseX = (e.clientX - rect.left) * scaleX;
                    const time = this.xToTime(mouseX);
                    this.saveState();
                    this.beatSignals.push(time);
                    this.beatSignals.sort((a,b) => a-b);
                    this.saveSignals();
                }
            }
            scanTriggers() {
                if (!this.waveform || !this.triggers.length) return alert("No triggers or waveform loaded.");
                this.prevBeats = [...this.beatSignals];
                this.performScan();
                window.$('scanPopup').classList.add('active');
                window.$('scanInitialActions').classList.remove('hidden');
                window.$('scanInitialActions').classList.add('flex');
                window.$('scanRefineActions').classList.add('hidden');
                window.$('scanRefineActions').classList.remove('flex');
                if (this.triggers.length > 0) {
                    const t = this.triggers[0]; 
                    const avgLvl = t.level || 0.5;
                    window.$('threshVal').innerText = Math.round(avgLvl * 100) + "%";
                    window.$('scanRefineActions').querySelector('input[type=range]').value = avgLvl;
                }
            }

            performScan() {
                const data = this.waveform;
                const duration = window.audioSys.audio.duration || 100;
                const minGap = this.scanMinGap; 
                if (this.prevBeats) { this.beatSignals = [...this.prevBeats]; }
                let addedCount = 0;
                this.triggers.forEach(trig => {
                    const startIdx = Math.floor((trig.start / duration) * data.length);
                    const endIdx = Math.floor((trig.end / duration) * data.length);
                    const sL = trig.startLevel !== undefined ? trig.startLevel : trig.level;
                    const eL = trig.endLevel !== undefined ? trig.endLevel : trig.level;
                    if (startIdx >= 0 && endIdx < data.length) {
                        let lastMarkTime = -1;
                        for(let i = startIdx; i <= endIdx; i++) {
                            const t = (i / data.length) * duration;
                            const fract = (t - trig.start) / (trig.end - trig.start);
                            const threshold = sL + (eL - sL) * fract;
                            const amp = Math.abs(data[i]);
                            if (amp > threshold) {
                                const isDup = this.beatSignals.some(b => Math.abs(b - t) < minGap);
                                if (!isDup && (lastMarkTime === -1 || (t - lastMarkTime) > minGap)) {
                                    this.beatSignals.push(t);
                                    lastMarkTime = t;
                                    addedCount++;
                                }
                            }
                        }
                    }
                });
                this.beatSignals.sort((a,b) => a-b);
                this.saveSignals();
                window.$('beatsFoundCount').innerText = `${addedCount} Beats Found`;
            }

            confirmScan() { window.$('scanPopup').classList.remove('active'); this.prevBeats = null; }
            discardScan() {
                if(this.prevBeats) { this.beatSignals = [...this.prevBeats]; this.saveSignals(); }
                window.$('scanInitialActions').classList.add('hidden');
                window.$('scanInitialActions').classList.remove('flex');
                window.$('scanRefineActions').classList.remove('hidden');
                window.$('scanRefineActions').classList.add('flex');
            }
            updateScanThreshold(val) {
                const v = parseFloat(val);
                window.$('threshVal').innerText = Math.round(v * 100) + "%";
                this.triggers.forEach(t => { t.level = v; t.startLevel = v; t.endLevel = v; });
                this.saveSignals();
            }
            updateScanGap(val) { this.scanMinGap = parseFloat(val); window.$('gapVal').innerText = this.scanMinGap + "s"; }
            reScan() {
                this.performScan();
                window.$('scanInitialActions').classList.remove('hidden');
                window.$('scanInitialActions').classList.add('flex');
                window.$('scanRefineActions').classList.add('hidden');
                window.$('scanRefineActions').classList.remove('flex');
            }
            
            teachAlgorithm() {
                if(window.learningController && this.beatSignals) {
                    window.learningController.learnFromTimeline(this.beatSignals);
                    // Flash the button for UX
                    const btn = document.querySelector('button[onclick="window.curveEditor.teachAlgorithm()"]');
                    if(btn) {
                        const originalText = btn.innerHTML;
                        btn.innerHTML = '<i class="fa-solid fa-check"></i> Taught';
                        btn.classList.add('bg-green-400');
                        setTimeout(() => {
                            btn.innerHTML = originalText;
                            btn.classList.remove('bg-green-400');
                        }, 1000);
                    }
                } else {
                    if(window.ui && window.ui.showToast) window.ui.showToast('Algorithm Controller not loaded yet.');
                }
            }

            draw() {
                const w = this.cv.width, h = this.cv.height, ctx = this.ctx;
                ctx.clearRect(0, 0, w, h);
                const duration = window.audioSys.audio.duration || 100;
                const viewDur = duration / this.zoom;

                if(this.waveform) {
                    const data = this.waveform;
                    const startSample = Math.floor((this.viewOffset / duration) * data.length);
                    const sampleRange = Math.floor((viewDur / duration) * data.length);
                    const step = Math.ceil(sampleRange / w);
                    const amp = (h / 2.5) * this.verticalZoom;
                    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
                    if (step > 0 && startSample >= 0) {
                        for(let i=0; i < w; i++) {
                            let max = 0;
                            const idx = startSample + (i * step);
                            if (idx < data.length) {
                                for(let j=0; j < step && (idx+j) < data.length; j++) {
                                    const val = Math.abs(data[idx + j]);
                                    if(val > max) max = val;
                                }
                                const height = Math.max(1, max * amp * 2);
                                ctx.fillRect(i, (h/2) - (height/2), 1, height);
                            }
                        }
                    }
                }
                
                ctx.strokeStyle = "rgba(255,255,255,0.05)";
                ctx.lineWidth = 1;
                const startSec = Math.floor(this.viewOffset);
                const endSec = Math.ceil(this.viewOffset + viewDur);
                for(let t=startSec; t<=endSec; t+=1) {
                    const x = this.timeToX(t);
                    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
                }

                const beatAlpha = this.editMode === 'beat' ? 1.0 : 0.3;
                this.beatSignals.forEach(t => {
                    const x = this.timeToX(t);
                    if (x >= -20 && x <= w + 20) {
                        const isSelected = this.selectedBeats.has(t);
                        const color = isSelected ? '#ffffff' : '#fbbf24';
                        const alpha = isSelected ? 1.0 : beatAlpha;
                        ctx.strokeStyle = color;
                        ctx.fillStyle = color;
                        ctx.globalAlpha = alpha;
                        ctx.lineWidth = isSelected ? 3 : 2;
                        ctx.beginPath(); ctx.moveTo(x, h/2); ctx.lineTo(x, h); ctx.stroke();
                        ctx.beginPath(); ctx.moveTo(x, h-20); ctx.lineTo(x-5, h-25); ctx.lineTo(x, h-30); ctx.lineTo(x+5, h-25); ctx.fill();
                        ctx.globalAlpha = 1.0;
                    }
                });

                const trigAlpha = this.editMode === 'trigger' ? 1.0 : 0.4;
                ctx.strokeStyle = `rgba(74, 222, 128, ${trigAlpha})`; 
                ctx.fillStyle = `rgba(74, 222, 128, ${trigAlpha})`;
                this.triggers.forEach(trig => {
                    const sx = this.timeToX(trig.start);
                    const ex = this.timeToX(trig.end);
                    const sL = trig.startLevel !== undefined ? trig.startLevel : trig.level;
                    const eL = trig.endLevel !== undefined ? trig.endLevel : trig.level;
                    if (ex > 0 && sx < w) {
                        const sy = (h/2) - (sL * h/2);
                        const ey = (h/2) - (eL * h/2);
                        ctx.lineWidth = 2;
                        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
                        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI*2); ctx.fill();
                        ctx.beginPath(); ctx.arc(ex, ey, 4, 0, Math.PI*2); ctx.fill();
                        ctx.fillStyle = `rgba(74, 222, 128, ${trigAlpha * 0.1})`;
                        ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.lineTo(ex, h/2); ctx.lineTo(sx, h/2); ctx.fill();
                        ctx.fillStyle = `rgba(74, 222, 128, ${trigAlpha})`; 
                    }
                });

                const curveAlpha = this.editMode === 'speed' ? 1.0 : 0.2;
                ctx.strokeStyle = "rgba(255,255,255,0.1)";
                ctx.beginPath(); ctx.moveTo(0, h/2); ctx.lineTo(w, h/2); ctx.stroke();
                const col = getComputedStyle(document.documentElement).getPropertyValue('--accent'); 
                ctx.strokeStyle = this.editMode === 'speed' ? col : `rgba(255,255,255,0.2)`;
                ctx.lineWidth = 3; 
                ctx.beginPath();
                this.pts.sort((a,b) => a.x - b.x); 
                let started = false;
                this.pts.forEach((p, i) => {
                    const x = this.timeToX(p.x * duration);
                    const y = (1 - p.y) * h; 
                    if(!started) { ctx.moveTo(x, y); started=true; }
                    else ctx.lineTo(x, y);
                }); 
                ctx.stroke();
                if (this.editMode === 'speed') {
                    ctx.fillStyle = "#fff"; 
                    this.pts.forEach(p => {
                        const x = this.timeToX(p.x * duration);
                        if(x >= -10 && x <= w + 10) { ctx.beginPath(); ctx.arc(x, (1 - p.y) * h, 6, 0, Math.PI * 2); ctx.fill(); }
                    });
                }
                
                if(this.isSelecting && this.selectionRect) {
                    ctx.fillStyle = "rgba(96, 165, 250, 0.2)";
                    ctx.strokeStyle = "rgba(96, 165, 250, 0.6)";
                    ctx.lineWidth = 1;
                    const { x, y, w, h } = this.selectionRect;
                    ctx.fillRect(x, y, w, h);
                    ctx.strokeRect(x, y, w, h);
                }

                const playTime = window.audioSys.audio.currentTime;
                const playX = this.timeToX(playTime);
                if(playX >= -10 && playX <= w + 10) {
                    ctx.strokeStyle = "#3b82f6"; ctx.lineWidth = 2; ctx.shadowBlur = 10; ctx.shadowColor = "#3b82f6";
                    ctx.beginPath(); ctx.moveTo(playX, 0); ctx.lineTo(playX, h); ctx.stroke(); ctx.shadowBlur = 0;
                    ctx.fillStyle = "#3b82f6"; ctx.beginPath(); ctx.moveTo(playX - 6, 0); ctx.lineTo(playX + 6, 0); ctx.lineTo(playX, 8); ctx.fill();
                }
            }

            getSpeedAt(p){ this.pts.sort((a,b)=>a.x-b.x); let p1=this.pts[0],p2=this.pts[this.pts.length-1]; for(let i=0;i<this.pts.length-1;i++)if(p>=this.pts[i].x&&p<=this.pts[i+1].x){p1=this.pts[i];p2=this.pts[i+1];break;} const r=p2.x-p1.x; if(r===0)return p1.y*2.0; const t=(p-p1.x)/r; return (p1.y+(p2.y-p1.y)*t)*2.0; }
            saveSignals() { 
                if(window.player.currentTrack) { 
                    window.player.currentTrack.beatSignals = this.beatSignals;
                    window.player.currentTrack.triggers = this.triggers;
                    window.player.currentTrack.speedPoints = this.pts; 
                    window.player.db.update(window.player.currentTrack.id, { 
                        beatSignals: this.beatSignals, triggers: this.triggers, speedPoints: this.pts 
                    }); 
                    if(window.libraryMgr && window.libraryMgr.save) window.libraryMgr.save();
                } 
            }
            teachAlgorithm() {
                if(!this.waveform || !this.beatSignals.length) return window.ui.showToast("Add some beats first to teach the algorithm!");
                
                window.ui.showToast("Machine Learning: Analyzing DPPD Envelopes...");
                
                // --- 1. Learn Optimal MinGap ---
                let gaps = [];
                for(let i=1; i<this.beatSignals.length; i++) {
                    gaps.push(this.beatSignals[i] - this.beatSignals[i-1]);
                }
                gaps.sort((a,b)=>a-b);
                // Find 5th percentile gap to avoid cutting off fast double-beats
                let optimalGap = gaps.length > 0 ? gaps[Math.floor(gaps.length * 0.05)] * 0.95 : 0.18;
                if(optimalGap < 0.05) optimalGap = 0.05;

                // --- 2. Replicate DPPD RMS Engine locally to solve for exact Z-Score ---
                const data = this.waveform;
                const duration = window.audioSys.audio.duration || 100;
                const sampleRate = data.length / duration;
                const windowSize = Math.floor(sampleRate * 0.015); // 15ms window
                
                const envelope = [];
                const timestamps = [];
                
                for (let i = 0; i < data.length; i += windowSize) {
                    let sumSquares = 0;
                    let validSamples = 0;
                    for (let j = 0; j < windowSize && (i + j) < data.length; j++) {
                        const amplitude = data[i + j];
                        sumSquares += (amplitude * amplitude);
                        validSamples++;
                    }
                    envelope.push(Math.sqrt(sumSquares / validSamples));
                    timestamps.push(i / sampleRate);
                }
                
                const lag = 40; 
                const filteredEnv = new Float32Array(envelope);
                const userBeatZScores = [];

                for (let i = lag; i < envelope.length; i++) {
                    let sum = 0;
                    for(let j=i-lag; j<i; j++) sum += filteredEnv[j];
                    const localMean = sum / lag;
                    
                    let sumVariance = 0;
                    for(let j=i-lag; j<i; j++) sumVariance += Math.pow(filteredEnv[j] - localMean, 2);
                    const localStdDev = Math.sqrt(sumVariance / lag) || 0.0001; // prevent div/0
                    
                    const currentVal = envelope[i];
                    const currentTime = timestamps[i];
                    
                    // Is this timestamp near any of the user's manual beats?
                    const isUserBeat = this.beatSignals.some(bt => Math.abs(bt - currentTime) < 0.05); // within 50ms
                    
                    if (isUserBeat) {
                        const zScore = (currentVal - localMean) / localStdDev;
                        if (zScore > 0) userBeatZScores.push(zScore);
                    }
                    
                    // Simple influence step for next loop (0.2 influence)
                    filteredEnv[i] = currentVal; 
                }

                // --- 3. Determine the perfect Z-Score Threshold ---
                userBeatZScores.sort((a,b)=>a-b);
                // We want to capture the 10th percentile of user beats (ignore outliers/false clicks)
                // BUT we have to "un-multiply" it by 7 because autoGenerate() multiplies it by 7.0
                let rawZScore = userBeatZScores.length > 0 ? userBeatZScores[Math.floor(userBeatZScores.length * 0.1)] : 3.5;
                
                // Allow algorithm to be more aggressive if the user placed lots of beats
                let optimalThresh = (rawZScore * 0.9) / 7.0; 
                
                // Clamp mathematically to prevent absolutely insane values
                if(optimalThresh > 1.2) optimalThresh = 1.2; 
                if(optimalThresh < 0.05) optimalThresh = 0.05;

                const algoData = {
                    version: "3.0-DPPD-Solver",
                    learnedAt: Date.now(),
                    minGap: optimalGap,
                    threshold: optimalThresh,
                    frequencyBand: "Full Spectrum (RMS Decimated)"
                };
                
                localStorage.setItem('okmusic_bass_algorithm', JSON.stringify(algoData));
                window.ui.showToast(`DPPD Taught! New Threshold: ${(optimalThresh*7).toFixed(2)}`);
            }

            exportAlgorithmData() {
                const data = localStorage.getItem('okmusic_bass_algorithm');
                if(!data) return window.ui.showToast("You haven't taught the algorithm yet!");
                const blob = new Blob([data], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url; a.download = `okmusic_bass_algorithm_${Date.now()}.json`;
                a.click();
                URL.revokeObjectURL(url);
            }

            autoGenerate() { 
                if(!window.player.currentTrack || !this.waveform) return window.ui.showToast("Wait for track to finish loading."); 
                
                let minGapMs = 180;
                let zThresh = 3.5;
                const cached = localStorage.getItem('okmusic_bass_algorithm');
                if(cached) {
                    try {
                        const parsed = JSON.parse(cached);
                        minGapMs = parsed.minGap ? parsed.minGap * 1000 : 180;
                        zThresh = parsed.threshold ? parsed.threshold * 7.0 : 3.5;
                        window.ui.showToast(`Applying cached algorithm...`);
                    } catch(e) {}
                } else {
                    window.ui.showToast("Extracting Transient DPPD Peaks...");
                }

                // Protect UI by putting up a loading state visually if needed
                window.$('vizCanvas').style.opacity = '0.5';

                this.saveState();

                // 1. Create Web Worker Blob String
                const AutoBeatWorkerCode = `
                self.onmessage = function(e) {
                   const { audioData, sampleRate, windowMs, zThreshold, influence, minGapMs } = e.data;
                   
                   const windowSize = Math.floor(sampleRate * (windowMs / 1000));
                   const minGapSeconds = minGapMs / 1000;
                   
                   const envelope = [];
                   const timestamps = [];
                   
                   // RMS Envelope Extraction
                   for (let i = 0; i < audioData.length; i += windowSize) {
                       let sumSquares = 0;
                       let validSamples = 0;
                       for (let j = 0; j < windowSize && (i + j) < audioData.length; j++) {
                           const amplitude = audioData[i + j];
                           sumSquares += (amplitude * amplitude);
                           validSamples++;
                       }
                       const rms = Math.sqrt(sumSquares / validSamples);
                       envelope.push(rms);
                       timestamps.push(i / sampleRate);
                   }
                   
                   // Dynamic Parametric Peak Detection (DPPD) via Z-Scores
                   const detectedBeats = [];
                   let lastBeatTime = -1;
                   const lag = 40; 
                   const filteredEnv = new Float32Array(envelope);
                   
                   const calculateMean = (startIndex, length, arr) => {
                       let sum = 0;
                       for(let i = startIndex; i < startIndex + length; i++) sum += arr[i];
                       return sum / length;
                   };
                   
                   const calculateStdDev = (startIndex, length, arr, mean) => {
                       let sumVariance = 0;
                       for(let i = startIndex; i < startIndex + length; i++) {
                           const diff = arr[i] - mean;
                           sumVariance += (diff * diff);
                       }
                       return Math.sqrt(sumVariance / length);
                   };

                   for (let i = lag; i < envelope.length; i++) {
                       const localMean = calculateMean(i - lag, lag, filteredEnv);
                       const localStdDev = calculateStdDev(i - lag, lag, filteredEnv, localMean);
                       
                       const currentVal = envelope[i];
                       const currentTime = timestamps[i];
                       
                       if (Math.abs(currentVal - localMean) > zThreshold * localStdDev) {
                           if (currentTime - lastBeatTime > minGapSeconds) {
                               detectedBeats.push(currentTime);
                               lastBeatTime = currentTime;
                               filteredEnv[i] = (influence * currentVal) + ((1 - influence) * filteredEnv[i - 1]);
                           } else {
                               filteredEnv[i] = currentVal;
                           }
                       } else {
                           filteredEnv[i] = currentVal;
                       }
                   }
                   self.postMessage({ beats: detectedBeats });
                };
                `;

                const blob = new Blob([AutoBeatWorkerCode], { type: 'application/javascript' });
                const workerUrl = URL.createObjectURL(blob);
                const worker = new Worker(workerUrl);

                worker.onmessage = (e) => {
                    this.beatSignals = e.data.beats;
                    this.saveSignals();
                    worker.terminate();
                    URL.revokeObjectURL(workerUrl);
                    window.$('vizCanvas').style.opacity = '1';
                    window.ui.showToast(`Found ${this.beatSignals.length} DPPD Beats!`);
                };

                worker.onerror = (err) => {
                    console.error("Worker failed:", err);
                    worker.terminate();
                    URL.revokeObjectURL(workerUrl);
                    window.$('vizCanvas').style.opacity = '1';
                    window.ui.showToast("Worker Error!");
                };

                // The this.waveform float32 array cannot be zero-copy transferred away because 
                // we need it for UI drawing continuously. So we pass a cloned slice down.
                const bufferToProc = this.waveform.slice(0); // Clones buffer
                
                worker.postMessage({
                    audioData: bufferToProc,
                    sampleRate: window.audioSys.audio.sampleRate || 44100, // Approximate UI playback node rate
                    windowMs: 15,
                    zThreshold: zThresh,
                    influence: 0.1,
                    minGapMs: minGapMs
                }, [bufferToProc.buffer]); // Zero copy the slice
            }
            reset() { this.saveState(); this.pts=[{x:0,y:0.5},{x:1,y:0.5}]; this.triggers = []; this.beatSignals = []; this.saveSignals(); }
            rendPre() { const l=window.$('presetList'); l.innerHTML=''; this.presets.forEach(p=>{const b=document.createElement('button'); b.className='preset-chip'; b.innerText=p.name; b.onclick=()=>{this.pts=JSON.parse(JSON.stringify(p.pts));}; l.appendChild(b)}); }
            openSaveModal() { window.$('presetModal').style.opacity='1'; window.$('presetModal').style.pointerEvents='auto'; window.$('presetNameInput').value=''; window.$('presetNameInput').focus(); }
            closeSaveModal() { window.$('presetModal').style.opacity='0'; window.$('presetModal').style.pointerEvents='none'; }
            confirmSave() { const n=window.$('presetNameInput').value; if(n){this.presets.push({name:n,pts:JSON.parse(JSON.stringify(this.pts))}); localStorage.setItem('sv_presets',JSON.stringify(this.presets)); this.rendPre(); this.closeSaveModal(); } }
        };

        class UI {
            constructor() {
                this.editType=null; this.editId=null; this.tempArt=null;
                this.activeContextId = null;
                this.lastActiveTop = -1; // Initialize to -1
                this.selectMode = false;
                this.selectedIds = [];
                
                document.addEventListener('click', (e) => {
                    if (!e.target.closest('#contextMenu')) {
                        window.$('contextMenu').style.display = 'none';
                    }
                });

                window.$('progressBar').addEventListener('input',e=>{
                    if(window.audioSys.audio.duration){
                        const t = (e.target.value/100)*window.audioSys.audio.duration;
                        window.audioSys.audio.currentTime=t;
                    }
                });
                
                window.addEventListener('keydown', (e) => {
                    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
                    if (e.code === 'Space') { e.preventDefault(); window.player.togglePlay(); }
                    else if (e.code === 'ArrowRight') { 
                        window.audioSys.audio.currentTime += 5; 
                    }
                    else if (e.code === 'ArrowLeft') { 
                        window.audioSys.audio.currentTime -= 5; 
                    }
                    else if (e.code === 'ArrowUp') { window.audioSys.gain.gain.value = Math.min(1, window.audioSys.gain.gain.value + 0.05); }
                    else if (e.code === 'ArrowDown') { window.audioSys.gain.gain.value = Math.max(0, window.audioSys.gain.gain.value - 0.05); }
                    else if (e.code === 'KeyM') { window.audioSys.gain.gain.value = 0; }
                });
            }
            
            showContextMenu(e, type, id) {
                e.preventDefault();
                e.stopPropagation();
                
                this.activeContextId = id;
                this.activeContextType = type;
                
                const menu = window.$('contextMenu');
                menu.style.display = 'flex';
                
                let x = e.clientX;
                let y = e.clientY;
                const w = window.innerWidth;
                const h = window.innerHeight;
                if (x + 160 > w) x = w - 170;
                if (y + 100 > h) y = h - 110;
                
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
            }
            
            handleContextAction(action) {
                if (!this.activeContextId) return;
                
                if (action === 'edit') {
                    this.openEdit(this.activeContextType, this.activeContextId);
                } else if (action === 'delete') {
                    window.libraryMgr.deleteItem(this.activeContextId);
                } else if (action === 'queue') {
                    if (this.activeContextType === 'song') {
                        window.player.queue.push(this.activeContextId);
                        this.showToast("Added to Queue");
                        this.renderQueue();
                    }
                }
                
                window.$('contextMenu').style.display = 'none';
            }
            
            // Add handler for dropping onto the root area from a folder
            handleRootDrop(e) {
                e.preventDefault();
                const s = window.libraryMgr.dragSrc;
                if (s) {
                    s.parentList.splice(s.idx, 1);
                    window.libraryMgr.structure.push(s.item);
                    window.libraryMgr.save();
                    this.renderLibrary();
                }
            }

            // CRITICAL: UPDATES ACTIVE STATE WITHOUT RE-RENDERING DOM
            highlightActiveTrack(id) {
                const el = window.$('libraryList');
                // Remove old active
                el.querySelectorAll('.lib-card.active').forEach(c => c.classList.remove('active'));
                
                // Add new active by ID
                const card = el.querySelector(`.lib-card[data-id="${id}"]`);
                if (card) {
                    card.classList.add('active');
                    
                    // Reset 'active-parent' since we have a direct hit
                    el.querySelectorAll('.active-parent').forEach(h => h.classList.remove('active-parent'));
                }
                
                // Update indicator position
                setTimeout(() => this.updateActiveIndicator(), 50);
            }

            // SEARCH HANDLER with DEBOUNCE and HIDE INDICATOR
            handleSearch(val) {
                // Hide indicator immediately to prevent glitching
                const indicator = document.getElementById('active-indicator');
                if (indicator) indicator.style.opacity = '0';
                
                this.renderLibrary(val);
                
                // Re-check after render
                setTimeout(() => {
                    this.updateActiveIndicator();
                    // Fade back in only if we found a valid target
                    if (this.lastActiveTop !== -1 && indicator) {
                         // Only if target exists on screen
                         const el = window.$('libraryList');
                         const target = el.querySelector('.lib-card.active') || el.querySelector('.active-parent');
                         if (target) indicator.style.opacity = '1';
                    }
                }, 100);
            }

            // TOGGLE FOLDER WITHOUT RE-RENDER
            toggleFolder(folderId) {
                const folderDiv = document.getElementById(`folder-${folderId}`);
                if (!folderDiv) return;
                
                const content = folderDiv.querySelector('.lib-folder-content');
                const icon = folderDiv.querySelector('.lib-folder-title i');
                const chevron = folderDiv.querySelector('.fa-chevron-down, .fa-chevron-up');
                const header = folderDiv.querySelector('.lib-folder-header');
                const indicator = document.getElementById('active-indicator');
                
                // Find data object
                const folderItem = window.libraryMgr.findItem(folderId);
                const hasActive = this.checkActiveInFolder(folderItem);
                
                if (folderItem.isOpen) {
                    // Close
                    content.classList.remove('open');
                    icon.className = `fa-solid fa-folder`;
                    if(folderItem.color) icon.style.color = folderItem.color;
                    chevron.className = `fa-solid fa-chevron-down text-[10px] opacity-50`;
                    folderItem.isOpen = false;
                    
                    // SMART BORDER: SNAP TO HEADER FORCE
                    if (hasActive) {
                        header.classList.add('active-parent');
                        // IMPORTANT: Force instant update to lock it
                        this.updateActiveIndicator(); 
                    }
                } else {
                    // Open
                    content.classList.add('open');
                    icon.className = `fa-solid fa-folder-open`;
                    if(folderItem.color) icon.style.color = folderItem.color;
                    chevron.className = `fa-solid fa-chevron-up text-[10px] opacity-50`;
                    folderItem.isOpen = true;
                    
                    // IMPORTANT: Clear active parent immediately so border wants to go to song
                    header.classList.remove('active-parent');
                    
                    // SUPER TRACKING LOOP
                    // Disable CSS transition on border to prevent lag while tracking moving target
                    if(indicator) indicator.classList.add('no-transition');
                    
                    let frames = 0;
                    const trackLoop = () => {
                        this.updateActiveIndicator();
                        frames++;
                        if(frames < 60) {
                            requestAnimationFrame(trackLoop);
                        } else {
                            // Re-enable transition after animation done
                            if(indicator) indicator.classList.remove('no-transition');
                        }
                    };
                    requestAnimationFrame(trackLoop);
                }
                
                // Always run tracking loop for external songs too (shifts layout)
                if (!hasActive && indicator) {
                     let frames = 0;
                     if(indicator) indicator.classList.add('no-transition');
                     const trackLoop = () => {
                        this.updateActiveIndicator();
                        frames++;
                        if(frames < 60) requestAnimationFrame(trackLoop);
                        else if(indicator) indicator.classList.remove('no-transition');
                    };
                    requestAnimationFrame(trackLoop);
                }
                
                // Save state
                window.libraryMgr.save();
            }

            toggleSelectMode() {
                this.selectMode = !this.selectMode;
                if (!this.selectMode) this.selectedIds = [];
                window.$('multiSelectBar').classList.toggle('hidden', !this.selectMode);
                window.$('selectBtn').classList.toggle('text-[var(--accent)]', this.selectMode);
                this.updateSelectCount();
                this.renderLibrary();
            }

            toggleSelection(id) {
                if (this.selectedIds.includes(id)) {
                    this.selectedIds = this.selectedIds.filter(x => x !== id);
                } else {
                    this.selectedIds.push(id);
                }
                this.updateSelectCount();
                this.renderLibrary(); // Re-render to update checks
            }

            updateSelectCount() {
                if (window.$('selectCountDisplay')) window.$('selectCountDisplay').innerText = `${this.selectedIds.length} Selected`;
            }

            async deleteSelected() {
                if(this.selectedIds.length === 0) return;
                if(confirm(`Are you sure you want to delete ${this.selectedIds.length} items?`)) {
                    for(const id of this.selectedIds) {
                        await new Promise(r => window.libraryMgr.deleteItem(id, r));
                    }
                    this.toggleSelectMode(); // Will disable mode and clear selections
                }
            }

            renderLibrary(filterText = "") {
                const el = window.$('libraryList');
                if (!el) return;
                
                el.innerHTML = '';

                // Add Indicator Element to DOM
                const indicator = document.createElement('div');
                indicator.id = 'active-indicator';
                // Initially hide until position confirmed
                indicator.style.opacity = '0'; 
                el.appendChild(indicator);
                
                // Add Drag Insertion Line
                const dragMarker = document.createElement('div');
                dragMarker.id = 'drag-marker';
                el.appendChild(dragMarker);
                
                // Create transparent drag image
                const emptyDragImage = new Image();
                emptyDragImage.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

                // NEW: RECURSIVE BUILD FUNCTION FOR CARDS & ACCORDIONS
                const buildUI = (items, parentList) => {
                    if (!items.length) return;

                    items.forEach((item, idx) => {
                        // FILTER LOGIC
                        if (filterText) {
                            if (item.type === 'folder') {
                                // Search inside folder, if found, render flat
                                buildUI(item.items, item.items); 
                            } else if (item.type === 'song') {
                                const s = window.player.songs.find(x => x.id === item.id);
                                if (s && s.name.toLowerCase().includes(filterText.toLowerCase())) {
                                    renderSongCard(item, s, parentList, idx, el, true, filterText, emptyDragImage); // Root level
                                }
                            }
                            return; 
                        }

                        if (item.type === 'song') {
                            const s = window.player.songs.find(x => x.id === item.id);
                            if (s) renderSongCard(item, s, parentList, idx, el, true, null, emptyDragImage); // Root level
                        } else if (item.type === 'folder') {
                            renderFolder(item, parentList, idx, el, emptyDragImage);
                        }
                    });
                };

                // --- HELPER: RENDER SONG CARD ---
                const renderSongCard = (item, song, parentList, idx, container, isRoot = false, highlightQuery = null, emptyImg) => {
                    const card = document.createElement('div');
                    card.className = 'lib-card group';
                    card.setAttribute('data-id', item.id); // IMPORTANT FOR SELECTION
                    
                    card.draggable = true;
                    if (window.player.currId === item.id) card.classList.add('active');

                    // DRAG START
                    card.ondragstart = e => {
                        e.stopPropagation();
                        // 1. Create the Custom Proxy Element
                        const isSelected = this.selectedIds.includes(item.id);
                        const proxy = document.createElement('div');
                        proxy.className = 'lib-drag-proxy';
                        proxy.innerHTML = isSelected && this.selectMode 
                            ? `<i class="fa-solid fa-layer-group"></i><span>Moving ${this.selectedIds.length} Items</span>`
                            : `<i class="fa-solid fa-music"></i><span>${song.name}</span>`;
                        document.body.appendChild(proxy);
                        
                        // 2. Set it as the drag image
                        e.dataTransfer.setDragImage(proxy, 20, 22);
                        setTimeout(() => document.body.removeChild(proxy), 0);

                        if (this.selectMode && isSelected) {
                            window.libraryMgr.dragSrc = { 
                                items: this.selectedIds.map(id => window.libraryMgr.findItem(id)).filter(x => x), 
                                type: 'multi' 
                            };
                        } else {
                            window.libraryMgr.dragSrc = { item, parentList, idx, type: 'single' };
                        }
                        card.style.opacity = '0.5';
                    };
                    card.ondragend = () => {
                        card.style.opacity = '1';
                        const marker = document.getElementById('drag-marker');
                        if(marker) marker.style.opacity = '0'; // Hide smooth
                        document.querySelectorAll('.drag-highlight').forEach(e => e.classList.remove('drag-highlight'));
                    };

                    // DRAG OVER (Reordering) - UPDATED FOR INSERTION LINE
                    card.ondragover = e => {
                        e.preventDefault();
                        e.stopPropagation();
                        const src = window.libraryMgr.dragSrc;
                        if (!src || src.item.id === item.id) return;
                        
                        // Calculate position relative to the main container
                        // This allows smooth sliding even if target is inside nested divs
                        let current = card;
                        let topOffset = 0;
                        const mainContainer = document.getElementById('libraryList');
                        
                        // Walk up to find offset relative to root container
                        while(current && current !== mainContainer) {
                            topOffset += current.offsetTop;
                            current = current.offsetParent;
                        }

                        const rect = card.getBoundingClientRect();
                        const relY = e.clientY - rect.top;
                        
                        // Logic for "Before" or "After"
                        let markerTop = topOffset;
                        if (relY > rect.height / 2) {
                            markerTop += rect.height + 8; // +gap
                            window.libraryMgr.dropTarget = { list: parentList, idx: idx, pos: 'after' };
                        } else {
                            window.libraryMgr.dropTarget = { list: parentList, idx: idx, pos: 'before' };
                        }
                        
                        const marker = document.getElementById('drag-marker');
                        if(marker) {
                            marker.style.top = markerTop + 'px';
                            marker.style.opacity = '1';
                        }
                    };
                    
                    card.ondragleave = () => {
                        // Optional: Hide marker if leaving specific area, but usually handled by other dragover
                    };

                    // DROP - UPDATED TO USE TARGET
                    card.ondrop = e => {
                        e.preventDefault();
                        e.stopPropagation();
                        const src = window.libraryMgr.dragSrc;
                        const tgt = window.libraryMgr.dropTarget;
                        if (!src || !tgt || src.type === 'multi') return; // Multi-drag only supported for folder drops for now
                        
                        src.parentList.splice(src.idx, 1);
                        let insertIdx = tgt.idx;
                        if (src.parentList === tgt.list && src.idx < tgt.idx) insertIdx--;
                        if (tgt.pos === 'after') insertIdx++;
                        tgt.list.splice(insertIdx, 0, src.item);
                        
                        window.libraryMgr.save();
                        this.renderLibrary();
                    };

                    // CONTENT
                    const iconBox = document.createElement('div');
                    iconBox.className = 'lib-card-icon';
                    
                    if (this.selectMode) {
                        const isSelected = this.selectedIds.includes(item.id);
                        iconBox.innerHTML = isSelected 
                            ? '<i class="fa-solid fa-circle-check text-[var(--accent)] text-lg"></i>' 
                            : '<i class="fa-regular fa-circle text-white/30 text-lg"></i>';
                        if (isSelected) card.classList.add('border-[var(--accent)]', 'bg-[var(--accent-dim)]');
                    } else {
                        iconBox.innerHTML = '<i class="fa-solid fa-music text-sm opacity-50"></i>';
                    }

                    const infoBox = document.createElement('div');
                    infoBox.className = 'lib-card-info';
                    
                    const title = document.createElement('div');
                    title.className = 'lib-card-title';
                    
                    // HIGHLIGHT LOGIC
                    if (highlightQuery) {
                        const regex = new RegExp(`(${highlightQuery})`, 'gi');
                        title.innerHTML = song.name.replace(regex, '<span class="text-highlight">$1</span>');
                    } else {
                        title.innerText = song.name;
                    }
                    
                    const subContainer = document.createElement('div');
                    subContainer.className = 'lib-card-sub-container';
                    
                    const sub = document.createElement('div');
                    sub.className = 'lib-card-sub';
                    subContainer.appendChild(sub);

                    // ANIMATION LOGIC (Only active on render, not click update)
                    if(song.isNew) {
                        sub.innerText = 'NEW';
                        sub.style.color = '#4ade80';
                        subContainer.style.height = '14px';
                        subContainer.style.marginTop = '2px';
                    } else {
                        subContainer.style.height = '0px';
                        subContainer.style.marginTop = '0px';
                        subContainer.style.opacity = '0';
                        card.classList.add('is-centered');
                    }

                    infoBox.appendChild(title);
                    infoBox.appendChild(subContainer);

                    card.appendChild(iconBox);
                    card.appendChild(infoBox);

                    // PLAY CLICK - CHANGED TO NOT RE-RENDER
                    card.onclick = () => {
                        if (this.selectMode) {
                            this.toggleSelection(item.id);
                            return;
                        }
                        
                        // Mark New
                        if(song.isNew) {
                            window.player.db.markAsSeen(song.id);
                            song.isNew = false;
                            
                            // VISIBLE ANIMATION SEQUENCE
                            // 1. Fade out the text
                            subContainer.style.opacity = '0';
                            
                            // 2. Wait for fade (200ms), then collapse height (300ms)
                            setTimeout(() => {
                                card.classList.add('is-centered'); // Triggers CSS height collapse
                                // Because card has min-height, content will visually center
                            }, 200);
                        }

                        // Play Logic
                        const ctxIds = parentList.filter(i => i.type === 'song').map(i => i.id);
                        // Tell player to play, BUT pass flag to NOT re-render library
                        window.player.play(item.id, ctxIds, false); 
                        
                        // Manually update UI
                        this.highlightActiveTrack(item.id);
                    };

                    // CONTEXT MENU
                    card.oncontextmenu = (e) => this.showContextMenu(e, 'song', item.id);

                    container.appendChild(card);
                };

                // --- HELPER: RENDER FOLDER ---
                const renderFolder = (item, parentList, idx, container, emptyImg) => {
                    const folderDiv = document.createElement('div');
                    folderDiv.className = 'lib-folder'; 
                    folderDiv.id = `folder-${item.id}`; // Needs ID for toggle
                    
                    // Folder Header
                    const header = document.createElement('div');
                    header.className = 'lib-folder-header';
                    
                    if (this.selectMode) {
                        const isSelected = this.selectedIds.includes(item.id);
                        if (isSelected) folderDiv.classList.add('border-[var(--accent)]', 'bg-[var(--accent-dim)]');
                        
                        header.onclick = (e) => {
                            e.stopPropagation();
                            this.toggleSelection(item.id);
                        };
                    } else {
                        header.onclick = () => {
                            this.toggleFolder(item.id);
                        };
                    }
                    
                    // Tint the whole folder background slightly if color exists
                    if(item.color) {
                        const rgbaBg = this.hexToRgba(item.color, 0.15); // 15% opacity tint
                        const rgbaBorder = this.hexToRgba(item.color, 0.3);
                        folderDiv.style.backgroundColor = rgbaBg;
                        folderDiv.style.borderColor = rgbaBorder;
                    }
                    
                    // DRAG START FOR FOLDER
                    header.draggable = true;
                    header.ondragstart = e => {
                         e.stopPropagation();
                         e.dataTransfer.setDragImage(emptyImg, 0, 0);
                         const isSelected = this.selectedIds.includes(item.id);
                         if (this.selectMode && isSelected) {
                             window.libraryMgr.dragSrc = { items: this.selectedIds.map(id => window.libraryMgr.findItem(id)).filter(x => x), type: 'multi' };
                         } else {
                             window.libraryMgr.dragSrc = { item, parentList, idx, type: 'single' };
                         }
                         folderDiv.style.opacity = '0.5';
                    }
                    header.ondragend = () => {
                         folderDiv.style.opacity = '1';
                         const marker = document.getElementById('drag-marker');
                         if(marker) marker.style.opacity = '0';
                         document.querySelectorAll('.drag-highlight').forEach(e => e.classList.remove('drag-highlight'));
                    }

                    // DROP INTO FOLDER
                    header.ondragover = e => {
                        e.preventDefault();
                        header.classList.add('drag-highlight');
                    };
                    header.ondragleave = () => header.classList.remove('drag-highlight');
                    header.ondrop = e => {
                        e.preventDefault();
                        e.stopPropagation();
                        header.classList.remove('drag-highlight');
                        const src = window.libraryMgr.dragSrc;
                        if (!src) return;
                        
                        if (src.type === 'multi') {
                            src.items.forEach(dragItem => {
                                if (dragItem.id === item.id) return; // Don't drop folder into itself
                                window.libraryMgr.removeItemFromStructure(dragItem.id);
                                item.items.push(dragItem);
                            });
                        } else {
                            if (src.item.id === item.id) return;
                            src.parentList.splice(src.idx, 1);
                            item.items.push(src.item);
                        }
                        
                        item.isOpen = true;
                        window.libraryMgr.save();
                        this.renderLibrary();
                    };

                    const titleArea = document.createElement('div');
                    titleArea.className = 'lib-folder-title';
                    const icon = document.createElement('i');
                    icon.className = `fa-solid fa-${item.isOpen ? 'folder-open' : 'folder'}`;
                    if(item.color) icon.style.color = item.color;
                    
                    titleArea.appendChild(icon);
                    titleArea.appendChild(document.createTextNode(item.name));
                    
                    const chevron = document.createElement('i');
                    chevron.className = `fa-solid fa-chevron-${item.isOpen ? 'up' : 'down'} text-[10px] opacity-50`;

                    header.appendChild(titleArea);
                    header.appendChild(chevron);
                    
                    // SMART BORDER TARGET ID
                    // If any song inside is active and folder is closed, this header becomes the target
                    const hasActiveSong = this.checkActiveInFolder(item);
                    if(hasActiveSong && !item.isOpen) {
                        header.classList.add('active-parent'); // Marker class
                    }

                    header.oncontextmenu = (e) => this.showContextMenu(e, 'folder', item.id);

                    // Folder Content - Changed for Grid Animation
                    const content = document.createElement('div');
                    content.className = `lib-folder-content ${item.isOpen ? 'open' : ''}`;
                    
                    const inner = document.createElement('div');
                    inner.className = 'lib-folder-inner';
                    content.appendChild(inner);

                    // RECURSION FOR FOLDER ITEMS
                    if (item.items && item.items.length > 0) {
                        item.items.forEach((subItem, subIdx) => {
                             if(subItem.type === 'song') {
                                 const s = window.player.songs.find(x => x.id === subItem.id);
                                 if(s) renderSongCard(subItem, s, item.items, subIdx, inner, false, null, emptyImg); 
                             } else {
                                 renderFolder(subItem, item.items, subIdx, inner, emptyImg); // Recursive
                             }
                        });
                    } else {
                        const emptyMsg = document.createElement('div');
                        emptyMsg.className = "text-[10px] text-white/30 p-2 italic text-center";
                        emptyMsg.innerText = "Empty Folder";
                        inner.appendChild(emptyMsg);
                    }

                    folderDiv.appendChild(header);
                    folderDiv.appendChild(content);
                    container.appendChild(folderDiv);
                };

                // --- EXECUTE RENDER ---
                if (window.libraryMgr.structure.length === 0 && !filterText) {
                    const emptyState = document.createElement('div');
                    emptyState.className = 'lib-empty';
                    emptyState.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i><span>Drop Music Here</span>`;
                    emptyState.onclick = () => document.getElementById('fileInput').click();
                    
                    // Drag events for empty state
                    emptyState.ondragover = e => { e.preventDefault(); emptyState.style.borderColor = 'var(--accent)'; };
                    emptyState.ondragleave = () => { emptyState.style.borderColor = 'rgba(255,255,255,0.1)'; };
                    emptyState.ondrop = e => {
                        e.preventDefault();
                        if (e.dataTransfer.files.length > 0) {
                            window.player.handleUpload(e.dataTransfer);
                        }
                    };

                    el.appendChild(emptyState);
                } else {
                    buildUI(window.libraryMgr.structure, window.libraryMgr.structure);
                    
                    // Add a drop zone at the bottom of the list for moving items to root
                    const bottomDrop = document.createElement('div');
                    bottomDrop.style.height = "40px";
                    bottomDrop.style.marginTop = "10px";
                    bottomDrop.ondragover = e => {
                        e.preventDefault();
                        // e.dataTransfer.dropEffect = 'move';
                    };
                    bottomDrop.ondrop = e => {
                        e.preventDefault();
                        const src = window.libraryMgr.dragSrc;
                        if (src) {
                            src.parentList.splice(src.idx, 1);
                            window.libraryMgr.structure.push(src.item);
                            window.libraryMgr.save();
                            this.renderLibrary();
                        }
                    };
                    el.appendChild(bottomDrop);
                }

                // Trigger Animation Update after render
                // Use setTimeout to ensure DOM is painted
                setTimeout(() => this.updateActiveIndicator(), 100); 
            }
            
            // Helper to check if a folder contains the active song
            checkActiveInFolder(folderItem) {
                if(!folderItem.items) return false;
                for(let item of folderItem.items) {
                    if (item.type === 'song' && item.id === window.player.currId) return true;
                    if (item.type === 'folder' && this.checkActiveInFolder(item)) return true;
                }
                return false;
            }

            getFlatList(){const l=[]; const scan=i=>{i.forEach(x=>{if(x.type==='song')l.push(x.id); else if(x.type==='folder')scan(x.items);});}; scan(window.libraryMgr.structure); return l;}
            setTrack(s){ 
                window.$('trackTitle').innerText=s.name; 
                window.$('trackArtist').innerText=""; 
                if(s.art){
                    window.$('albumArt').style.backgroundImage=`url(${s.art})`; 
                    window.$('artPlaceholder').style.display='none';
                    const img = new Image();
                    img.crossOrigin = "Anonymous";
                    img.onload = () => {
                        const c = document.createElement('canvas');
                        c.width = 10; c.height = 10;
                        const ctx = c.getContext('2d');
                        ctx.drawImage(img, 0, 0, 10, 10);
                        const d = ctx.getImageData(0,0,10,10).data;
                        let r=0,g=0,b=0;
                        for(let i=0;i<d.length;i+=4){ r+=d[i]; g+=d[i+1]; b+=d[i+2]; }
                        r = (r/100)|0; g = (g/100)|0; b = (b/100)|0;
                        
                        // Boost Saturation
                        const max=Math.max(r,g,b), min=Math.min(r,g,b);
                        if(max > min) {
                            r = Math.min(255, r + (r-min)*0.5)|0;
                            g = Math.min(255, g + (g-min)*0.5)|0;
                            b = Math.min(255, b + (b-min)*0.5)|0;
                        }
                        
                        window.dominantColor = `rgb(${r},${g},${b})`;
                        
                        // Create a complementary/secondary color by shifting hue
                        window.dominantColor2 = `rgb(${g},${b},${r})`; 
                    };
                    img.src = s.art;
                }else{
                    window.$('albumArt').style.backgroundImage='none'; 
                    window.$('artPlaceholder').style.display='flex';
                    window.dominantColor = null; window.dominantColor2 = null;
                } 
            }
            updatePlayBtn(p){ window.$('btnPlay').innerHTML=p?'<i class="fa-solid fa-pause"></i>':'<i class="fa-solid fa-play ml-1"></i>'; }
            updateProgress(){ 
                const a=window.audioSys.audio; 
                if(!a.duration)return; 
                const pct = (a.currentTime/a.duration)*100;
                const bar = window.$('progressBar');
                bar.value = pct; 
                const precisePct = ((pct / 100) * (bar.offsetWidth - 12)) + 6;
                bar.style.background = `linear-gradient(to right, var(--accent) ${precisePct}px, rgba(255,255,255,0.3) ${precisePct}px)`;
                const f=s=>`${Math.floor(s/60)}:${Math.floor(s%60).toString().padStart(2,'0')}`; 
                window.$('currTime').innerText=f(a.currentTime); 
                window.$('totTime').innerText=f(a.duration); 
            }
            updateVolume(v){ 
                const pct = v * 100;
                const vs = window.$('volSlider');
                const precisePct = ((pct / 100) * (vs.offsetHeight - 12)) + 6;
                vs.style.background = `linear-gradient(to top, var(--accent) ${precisePct}px, rgba(255,255,255,0.1) ${precisePct}px)`;
                window.audioSys.setVolume(v); 
            }
            toggleLibrary(){ window.$('libraryPanel').classList.toggle('open'); window.$('settingsPanel').classList.remove('open'); window.$('queuePanel').classList.remove('open'); }
            toggleSettings(){ window.$('settingsPanel').classList.toggle('open'); window.$('libraryPanel').classList.remove('open'); window.$('queuePanel').classList.remove('open'); }
            toggleQueue(){ window.$('queuePanel').classList.toggle('open'); window.$('settingsPanel').classList.remove('open'); window.$('libraryPanel').classList.remove('open'); this.renderQueue(); }

            renderQueue() {
                const list = window.$('queueList');
                list.innerHTML = '';
                if(window.player.queue.length === 0) {
                    list.innerHTML = '<div class="text-[10px] text-white/30 text-center uppercase tracking-widest mt-4">Queue is empty</div>';
                    return;
                }
                window.player.queue.forEach((id, idx) => {
                    const song = window.player.songs.find(s => s.id === id);
                    if(!song) return;
                    const card = document.createElement('div');
                    card.className = 'w-full bg-white/5 border border-white/10 p-3 rounded-lg flex items-center gap-3 relative';
                    card.innerHTML = `
                        <div class="w-8 h-8 rounded shrink-0 bg-white/10 bg-cover bg-center" style="background-image: url(${song.art || ''})"></div>
                        <div class="flex-1 truncate">
                            <div class="text-xs font-bold text-white truncate">${song.name}</div>
                        </div>
                        <button class="text-white/50 hover:text-red-400" onclick="window.player.removeFromQueue(${idx})"><i class="fa-solid fa-xmark"></i></button>
                    `;
                    list.appendChild(card);
                });
            }
            setTheme(c){ document.documentElement.style.setProperty('--accent',c); localStorage.setItem('sv_theme',c); const h=parseInt(c.replace('#',''),16); const r=(h>>16)&255,g=(h>>8)&255,b=h&255; document.documentElement.style.setProperty('--accent-dim',`rgba(${r},${g},${b},0.15)`); document.documentElement.style.setProperty('--accent-glow',`rgba(${r},${g},${b},0.3)`); let min=Math.min(r,g,b),max=Math.max(r,g,b),d=max-min,hue=0; if(d>0){if(max==r)hue=((g-b)/d)%6;else if(max==g)hue=(b-r)/d+2;else hue=(r-g)/d+4;} hue=Math.round(hue*60);if(hue<0)hue+=360; document.documentElement.style.setProperty('--bg-hue',hue); }
            
            setThemeMode(mode) {
                this.themeMode = mode;
                localStorage.setItem('sv_theme_mode', mode);
                const solidContainer = window.$('solidColorContainer');
                const gradContainer = window.$('gradientColorContainer');
                const txtLabel = window.$('themeModeTxt');
                
                if (solidContainer) solidContainer.style.display = (mode === 'solid' || mode === 'solid-fill') ? 'flex' : 'none';
                if (gradContainer) gradContainer.style.display = (mode === 'gradient') ? 'flex' : 'none';

                if (txtLabel) {
                    if (mode === 'solid') txtLabel.innerText = "Solid Accent Color";
                    else if (mode === 'solid-fill') txtLabel.innerText = "Solid Full Color";
                    else if (mode === 'dominant') txtLabel.innerText = "Album Art (Dominant)";
                    else if (mode === 'gradient') txtLabel.innerText = "Custom 2-Color Gradient";
                    else if (mode === 'rainbow') txtLabel.innerText = "Rainbow Ghosting";
                }
            }
            
            updateGradientTheme() {
                const c1 = window.$('gradColor1').value;
                const c2 = window.$('gradColor2').value;
                localStorage.setItem('sv_grad_1', c1);
                localStorage.setItem('sv_grad_2', c2);
                this.themeGrad1 = c1;
                this.themeGrad2 = c2;
            }
            
            setFontFamily(fontFamilyString) {
                document.body.style.fontFamily = fontFamilyString;
                localStorage.setItem('sv_font_family', fontFamilyString);
                
                let fontName = fontFamilyString.split(',')[0].replace(/['"]/g, '').trim();
                if (fontName === 'Outfit') return;

                const linkId = 'font-' + fontName.replace(/\s+/g, '-').toLowerCase();
                if (!document.getElementById(linkId)) {
                    const link = document.createElement('link');
                    link.id = linkId;
                    link.rel = 'stylesheet';
                    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/\s+/g, '+')}:wght@300;400;500;600;700;800;900&display=swap`;
                    document.head.appendChild(link);
                }
            }
            
            openEdit(t,id){ 
                this.editType=t; this.editId=id; 
                window.$('trackEditor').style.opacity='1'; window.$('trackEditor').style.pointerEvents='auto'; 
                
                const colorInputDiv = window.$('editColorContainer');
                const artInputDiv = window.$('editArtContainer');
                const colorInput = window.$('editColorInput');
                
                if(t==='song'){
                    const s=window.player.songs.find(x=>x.id===id); 
                    window.$('editorTitle').innerText="Edit Track"; 
                    window.$('editName').value=s?s.name:"";
                    if(window.$('editArtUrl')) window.$('editArtUrl').value=s?(s.customArtUrl||""):"";
                    colorInputDiv.classList.add('hidden');
                    artInputDiv.classList.remove('hidden');
                } else {
                    const f=window.libraryMgr.findItem(id); 
                    window.$('editorTitle').innerText="Edit Folder"; 
                    window.$('editName').value=f?f.name:"";
                    colorInputDiv.classList.remove('hidden');
                    artInputDiv.classList.add('hidden');
                    colorInput.value = f.color || "#60a5fa";
                } 
            }
            
            closeEditor(){ window.$('trackEditor').style.opacity='0'; window.$('trackEditor').style.pointerEvents='none'; this.tempArt=null; }
            previewEditArt(i){ const f=i.files[0]; const r=new FileReader(); r.onload=e=>this.tempArt=e.target.result; r.readAsDataURL(f); }
            async saveEditor(){ 
                const n=window.$('editName').value; 
                if(this.editType==='song'){
                    const u={name:n}; 
                    const customUrl = window.$('editArtUrl') ? window.$('editArtUrl').value.trim() : "";
                    if(this.tempArt) u.art=this.tempArt; 
                    else if(customUrl) { u.customArtUrl = customUrl; u.art = customUrl; }
                    
                    await window.player.db.update(this.editId,u); window.player.loadLib();
                } else {
                    const u={name:n}; 
                    if(this.tempArt)u.art=this.tempArt; 
                    u.color = window.$('editColorInput').value;
                    window.libraryMgr.updateFolder(this.editId,u);
                } 
                this.closeEditor(); 
            }

            openPlaylistImporter() {
                window.$('playlistModal').style.opacity = '1';
                window.$('playlistModal').style.pointerEvents = 'auto';
                window.$('playlistUrlInput').value = '';
                window.$('playlistStatus').classList.add('hidden');
                window.$('btnScanPlaylist').innerText = "SCAN LINK";
            }

            closePlaylistImporter() {
                window.$('playlistModal').style.opacity = '0';
                window.$('playlistModal').style.pointerEvents = 'none';
            }

            async scanPlaylist() {
                const url = window.$('playlistUrlInput').value.trim();
                if(!url) return;
                
                const btn = window.$('btnScanPlaylist');
                const stat = window.$('playlistStatus');
                const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1' ? 'http://localhost:3000' : 'https://okfait-github-io.vercel.app';
                
                if(btn.innerText.includes("IMPORT")) {
                    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> PREPARING...';
                    btn.style.pointerEvents = 'none';
                    
                    try {
                        const tracks = this._pendingPlaylistTracks || [];
                        const folderId = crypto.randomUUID();
                        const folderName = this._pendingPlaylistName || "Imported Playlist";
                        
                        // Create Folder FIRST
                        const newFolder = {
                            type: 'folder', id: folderId, name: folderName, 
                            items: [], isOpen: true, color: '#1db954' // Spotify Green
                        };
                        window.libraryMgr.structure.unshift(newFolder);

                        let successCount = 0;

                        for(let i=0; i<tracks.length; i++) {
                            const t = tracks[i];
                            btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin mr-2"></i> DOWNLOADING ${i+1}/${tracks.length}`;
                            try {
                                const fetchUrl = `${API_BASE}/api/fetch?url=${encodeURIComponent(t.url || t.name)}`;
                                const res = await fetch(fetchUrl);
                                if (!res.ok) throw new Error("Failed to stream");
                                const blob = await res.blob();
                                
                                const songId = "stream-" + Date.now() + "-" + i;
                                const newSong = { id: songId, name: t.name, blob: blob, beatSignals: [], speedPoints: [] };
                                await window.player.db.add(newSong);
                                
                                // Push to new folder
                                newFolder.items.push({ type: 'song', id: songId });
                                
                                successCount++;
                            } catch(e) { console.warn("Skipped track:", t.name); }
                        }
                        
                        window.libraryMgr.save();
                        await window.player.loadLib();
                        this.showToast(`Imported ${successCount} tracks successfully!`);
                        this.closePlaylistImporter();
                    } catch (e) {
                        alert("Import stopped: " + e.message);
                        btn.innerHTML = 'IMPORT FAILED - TRY AGAIN';
                        btn.style.pointerEvents = 'auto';
                    }
                    return;
                }

                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-2"></i> SCANNING...';
                btn.style.pointerEvents = 'none';
                
                try {
                    const res = await fetch(`${API_BASE}/api/playlist?url=${encodeURIComponent(url)}`);
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || "Failed to scan playlist");
                    
                    this._pendingPlaylistTracks = data.tracks;
                    this._pendingPlaylistName = data.title || "Imported Playlist";
                    
                    stat.classList.remove('hidden');
                    stat.classList.remove('animate-pulse');
                    stat.innerHTML = `<i class="fa-solid fa-check mr-1"></i> Found ${data.tracks.length} Tracks! Ready to import.`;
                    btn.innerHTML = 'IMPORT TRACKS';
                    btn.style.pointerEvents = 'auto';
                } catch (e) {
                    alert("Scan failed: " + e.message);
                    btn.innerHTML = 'SCAN LINK';
                    btn.style.pointerEvents = 'auto';
                }
            }

            setBgBrightness(v){ window.$('bg-layer').style.opacity=v; localStorage.setItem('sv_bg_bright',v); }
            updateMetaTags(){ 
                const c=window.$('metaTags'); c.innerHTML=''; 
                if(window.audioSys.baseSpeed!=1) c.innerHTML+=`<span class="tag" style="background: rgba(168, 85, 247, 0.15); border-color: rgba(168, 85, 247, 0.3); color: #e879f9;">WARP ${window.audioSys.baseSpeed}x</span>`; 
                if(window.audioSys.bassVal>0) c.innerHTML+=`<span class="tag" style="background: rgba(239, 68, 68, 0.15); border-color: rgba(239, 68, 68, 0.3); color: #f87171;">BASS +${window.audioSys.bassVal}</span>`; 
                if(window.audioSys.reverbVal>0) c.innerHTML+=`<span class="tag" style="background: rgba(56, 189, 248, 0.15); border-color: rgba(56, 189, 248, 0.3); color: #7dd3fc;">REVERB ${window.audioSys.reverbVal}%</span>`; 
                if(window.player && window.player.autoDj) c.innerHTML+=`<span class="tag" style="background: rgba(34, 197, 94, 0.15); border-color: rgba(34, 197, 94, 0.3); color: #4ade80;">AUTO DJ</span>`;
            }

            showToast(msg){
                const t = window.$('toast');
                t.innerText = msg;
                t.classList.add('show');
                if(this.toastTimer) clearTimeout(this.toastTimer);
                this.toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
            }
            showSyncPopup(title, pct) {
                const pop = window.$('partySyncProgress');
                if(!pop) return;
                const icon = window.$('partySyncIcon');
                if (title.includes('Uploading') || title.includes('Streaming')) {
                    icon.className = 'fa-solid fa-cloud-arrow-up text-3xl text-[var(--accent)] mb-2 animate-bounce';
                } else {
                    icon.className = 'fa-solid fa-cloud-arrow-down text-3xl text-[var(--accent)] mb-2 animate-bounce';
                }
                window.$('partySyncTitle').innerText = title;
                window.$('partySyncPercent').innerText = pct;
                pop.style.display = 'block';
                window.$('partySetupModal').style.display = 'block';
            }
            updateSyncPopup(pct) {
                if(window.$('partySyncPercent')) window.$('partySyncPercent').innerText = pct;
            }
            hideSyncPopup() {
                const pop = window.$('partySyncProgress');
                if(pop) pop.style.display = 'none';
            }
            
            // Helper: Convert Hex to RGBA
            hexToRgba(hex, alpha) {
                let r = 0, g = 0, b = 0;
                if (hex.length === 4) {
                    r = parseInt(hex[1] + hex[1], 16);
                    g = parseInt(hex[2] + hex[2], 16);
                    b = parseInt(hex[3] + hex[3], 16);
                } else if (hex.length === 7) {
                    r = parseInt(hex.slice(1, 3), 16);
                    g = parseInt(hex.slice(3, 5), 16);
                    b = parseInt(hex.slice(5, 7), 16);
                }
                return `rgba(${r},${g},${b},${alpha})`;
            }

            // New Animation Logic
            updateActiveIndicator() {
                const el = window.$('libraryList');
                const indicator = document.getElementById('active-indicator');
                
                // Find visible target
                // PRIORITIZE FOLDER PARENT IF SET
                // This ensures if we are inside a closed folder, we stick to the header
                let target = el.querySelector('.active-parent');
                
                if (!target) {
                    // Fallback to active song card if visible
                    target = el.querySelector('.lib-card.active');
                }
                
                // If neither found, and we have an active track ID, maybe it's inside a folder not yet marked?
                // Redundant check, but safe
                if (!target && window.player.currId) {
                     // Check if active song is inside a closed folder
                     // This handles init state
                     const folders = el.querySelectorAll('.lib-folder');
                     folders.forEach(f => {
                         const fid = f.id.replace('folder-', '');
                         const fItem = window.libraryMgr.findItem(fid);
                         if(fItem && !fItem.isOpen && this.checkActiveInFolder(fItem)) {
                             target = f.querySelector('.lib-folder-header');
                             if(target) target.classList.add('active-parent');
                         }
                     });
                }

                if (!indicator) return;

                if (!target || target.offsetParent === null) {
                    indicator.style.opacity = '0';
                    return;
                }

                // Make visible if hidden
                indicator.style.opacity = '1';

                // Calculate total offsetTop relative to container (libraryList)
                // This accounts for nested positioning inside folders
                let actualTop = target.offsetTop;
                let current = target.offsetParent;
                while(current && current !== el) {
                    actualTop += current.offsetTop;
                    current = current.offsetParent;
                }

                const newHeight = target.offsetHeight;

                // First render or reset
                if (this.lastActiveTop === -1 || indicator.style.display === 'none') {
                    indicator.style.display = 'block';
                    indicator.style.top = actualTop + 'px';
                    indicator.style.height = newHeight + 'px';
                    this.lastActiveTop = actualTop;
                    return;
                }

                // If position hasn't changed, just ensure visibility
                if (Math.abs(actualTop - this.lastActiveTop) < 1 && Math.abs(newHeight - indicator.offsetHeight) < 1) {
                    indicator.style.display = 'block';
                    indicator.style.top = actualTop + 'px';
                    indicator.style.height = newHeight + 'px';
                    return;
                }

                // Force the indicator to start visually from the last known position to prevent jump
                indicator.style.display = 'block';
                // indicator.style.top = this.lastActiveTop + 'px'; // Start from old pos

                // Using CSS transition for smooth movement
                indicator.style.top = actualTop + 'px';
                indicator.style.height = newHeight + 'px';
                
                // Update internal tracker immediately for rapid clicks
                this.lastActiveTop = actualTop;
            }
        }

        class Player {
            constructor() {
                this.songs=[]; this.currId=null; this.loop=0; this.autoDj=false; this.playlist=[];
                this.shuffle = false;
                this.shuffleHistory = [];
                this.queue = [];
                this.db=new MusicDB(); this.db.init().then(()=>this.loadLib()); this.loadSettings();
                this.currentTrack = null; 
            }
            
            async handleUpload(input) {
                const audioFiles = [];
                const jsonFiles = [];
                const files = input.files ? input.files : input.items ? Array.from(input.items).filter(i=>i.kind==='file').map(i=>i.getAsFile()) : [];

                for(const f of files) {
                    if(f.type.includes('audio')) audioFiles.push(f);
                    else if(f.name.endsWith('.json')) jsonFiles.push(f);
                }
                for(const audioFile of audioFiles) {
                    let matchData = null;
                    const baseName = audioFile.name.replace(/\.[^/.]+$/, "");
                    const matchJson = jsonFiles.find(jf => jf.name.includes(baseName));
                    if (matchJson) {
                        try {
                            const text = await matchJson.text();
                            matchData = JSON.parse(text);
                        } catch(e) { console.warn("Failed to parse JSON", e); }
                    }
                    await this.db.add(audioFile, matchData);
                }
                this.loadLib();
            }

            async loadLib(){ const s=await this.db.getAll(); window.libraryMgr.sync(s); this.songs=s; }
            
            play(id, contextList=null, renderList = true){
                window.audioSys.init();
                if(contextList && Array.isArray(contextList)) {
                    // New playlist context, reset history if completely new
                    if (this.playlist.join(',') !== contextList.join(',')) {
                        this.shuffleHistory = [];
                    }
                    this.playlist=contextList; 
                }
                
                const s=this.songs.find(x=>x.id===id); if(!s)return;
                this.currId=s.id;
                this.currentTrack = s; 
                
                if(window.curveEditor) {
                    window.curveEditor.beatSignals = s.beatSignals || [];
                    if(s.speedPoints) window.curveEditor.pts = s.speedPoints;
                    if(window.curveEditor.isOpen) {
                        window.curveEditor.loadWaveform();
                    }
                }
                
                // LOAD AUDIO SETTINGS (GLOBAL OR PER SONG)
                if (window.audioSys.globalAudio) {
                    this.loadSettings();
                } else {
                    const bass = s.bassVal !== undefined ? s.bassVal : localStorage.getItem('sv_bass') || 0;
                    const spd = s.baseSpeed !== undefined ? s.baseSpeed : localStorage.getItem('sv_pitch') || 1.0;
                    const rev = s.reverbVal !== undefined ? s.reverbVal : localStorage.getItem('sv_reverb') || 0;
                    const xtr = s.xtremeOn !== undefined ? s.xtremeOn : localStorage.getItem('sv_xtreme') === 'true';
                    
                    document.querySelectorAll('.setting-slider')[1].value = bass;
                    document.querySelectorAll('.setting-slider')[2].value = rev;
                    document.querySelectorAll('.setting-slider')[3].value = spd;
                    window.$('xtremeToggle').checked = xtr;
                    
                    if(window.audioSys.ctx) {
                         window.audioSys.bass.gain.value = bass;
                         window.audioSys.baseSpeed = parseFloat(spd);
                         window.audioSys.revGain.gain.value = rev/50;
                         window.audioSys.bass.frequency.value = xtr ? 100 : 200;
                         window.audioSys.bass.Q.value = xtr ? 10 : 1;
                    }
                    window.audioSys.bassVal = bass;
                    window.audioSys.reverbVal = rev;
                    window.audioSys.xtremeOn = xtr;
                    window.audioSys.baseSpeed = parseFloat(spd);
                    window.$('bassVal').innerText = `+${bass}dB`;
                    window.$('pitchVal').innerText = spd + "x";
                    window.$('reverbVal').innerText = rev + "%";
                }
                window.ui.updateMetaTags();

                window.audioSys.audio.src=URL.createObjectURL(s.blob);
                window.audioSys.audio.preservesPitch=false; 
                
                if(window.partyMode && window.partyMode.active && window.partyMode.isHost) {
                    window.ui.showSyncPopup("Loading sounds...", "0%");
                    const finalStatus = window.$('syncStatus');
                    if (finalStatus) finalStatus.innerText = `Waiting for Client...`;
                    window.audioSys.audio.pause();
                } else {
                    window.audioSys.audio.play();
                }
                
                window.ui.setTrack(s); window.ui.updatePlayBtn(true);
                
                // IMPORTANT: Only re-render if explicitly requested (e.g. from shuffle next/prev)
                // Manual clicks will handle their own UI update to preserve animations
                if (renderList) {
                    window.ui.renderLibrary();
                } else {
                    // Even if we don't render list, we must ensure active indicator updates
                    // Handled by manual click usually, but good fallback
                    setTimeout(() => window.ui.updateActiveIndicator(), 0);
                }
                
                // Party Mode P2P Sync Trigger
                if(window.partyMode && window.partyMode.active) {
                    window.partyMode.broadcastInChunks(s);
                }
            }
            
            playFromData(id, name, base64) {
                window.audioSys.init();
                fetch(base64).then(res => res.blob()).then(blob => {
                    window.audioSys.audio.src=URL.createObjectURL(blob);
                    window.audioSys.audio.preservesPitch=false; window.audioSys.audio.play();
                    const s = { id: id, name: name, art: null, blob: blob, beatSignals: [], speedPoints: [] };
                    this.currentTrack = s;
                    window.ui.setTrack(s); window.ui.updatePlayBtn(true);
                    const status = window.$('syncStatus');
                    status.innerText = "Downloading Track...";
                    status.style.display = 'inline-block';
                    setTimeout(() => status.style.display = 'none', 3000);
                });
            }
            
            toggleShuffle() {
                this.shuffle = !this.shuffle;
                const btn = document.getElementById('shuffleBtn');
                if(this.shuffle) {
                    btn.classList.add('active');
                    this.shuffleHistory = []; // Reset history on toggle
                }
                else btn.classList.remove('active');
            }

            togglePlay(){
                window.audioSys.init(); if(!this.songs.length)return;
                if(!this.currId){ const flat=window.ui.getFlatList(); if(flat.length)this.play(flat[0], flat); }
                else if(window.audioSys.audio.paused){ 
                    window.audioSys.audio.play(); window.ui.updatePlayBtn(true); 
                    if(window.partyMode && window.partyMode.active) window.partyMode.broadcast({type: 'STATUS', playing: true, time: window.audioSys.audio.currentTime});
                }
                else { 
                    window.audioSys.audio.pause(); window.ui.updatePlayBtn(false); 
                    if(window.partyMode && window.partyMode.active) window.partyMode.broadcast({type: 'STATUS', playing: false, time: window.audioSys.audio.currentTime});
                }
            }
            
            removeFromQueue(idx) {
                if (this.queue && idx >= 0 && idx < this.queue.length) {
                    this.queue.splice(idx, 1);
                    window.ui.renderQueue();
                }
            }

            next(){ 
                if (this.queue && this.queue.length > 0) {
                    const nextId = this.queue.shift();
                    window.ui.renderQueue();
                    this.play(nextId);
                    return;
                }
                const l = this.playlist.length ? this.playlist : window.ui.getFlatList(); 
                if (l.length === 0) return;

                if (this.shuffle) {
                    // Smart Shuffle Logic: Avoid repeats until all songs played
                    let candidates = l.filter(id => !this.shuffleHistory.includes(id));
                    
                    // If we played everything, reset history to start over
                    if (candidates.length === 0) {
                        this.shuffleHistory = [];
                        candidates = [...l];
                    }
                    
                    // Try not to repeat the exact same song immediately if possible
                    if (candidates.length > 1 && this.currId) {
                        candidates = candidates.filter(id => id !== this.currId);
                    }

                    const rIdx = Math.floor(Math.random() * candidates.length);
                    const nextId = candidates[rIdx];
                    
                    this.shuffleHistory.push(nextId);
                    this.play(nextId);
                } else {
                    const i = l.indexOf(this.currId); 
                    if (i > -1) this.play(l[(i+1)%l.length]); 
                }
            }
            
            prev(){ 
                // Previous in shuffle just goes to history or previous random? 
                // Standard behavior: usually goes back in history. 
                // For simplicity here, we keep sequential prev, or simple random if needed.
                // Let's stick to sequential order for Prev to allow "Rewind", 
                // or if we want true history navigation we'd need a separate history stack.
                // Currently implementing sequential prev for predictability.
                const l=this.playlist.length?this.playlist:window.ui.getFlatList(); 
                const i=l.indexOf(this.currId); 
                if(i>-1)this.play(l[(i-1+l.length)%l.length]); 
            }
            
            onTick(){
                window.ui.updateProgress();
                if(window.audioSys.audio.duration){
                    const pct=window.audioSys.audio.currentTime/window.audioSys.audio.duration;
                    window.audioSys.audio.playbackRate=window.curveEditor.getSpeedAt(pct)*window.audioSys.baseSpeed;
                    
                    if(this.autoDj && window.audioSys.audio.duration-window.audioSys.audio.currentTime<5 && !this.fading){
                        this.fading=true;
                        
                        // Dual-deck crossfade logic
                        if (!window.fadeAudio) {
                            window.fadeAudio = new Audio();
                            window.fadeGain = window.audioSys.ctx.createGain();
                            const src = window.audioSys.ctx.createMediaElementSource(window.fadeAudio);
                            src.connect(window.fadeGain);
                            // Connect directly to master gain to ensure it plays out of the speakers
                            window.fadeGain.connect(window.audioSys.gain);
                        }
                        
                        // Swap tracks into the fade deck
                        window.fadeAudio.src = window.audioSys.audio.src;
                        window.fadeAudio.currentTime = window.audioSys.audio.currentTime;
                        window.fadeAudio.playbackRate = window.audioSys.audio.playbackRate;
                        window.fadeAudio.play().catch(e=>console.log("Fader unallowed", e));
                        
                        let oldVol = window.audioSys.gain.gain.value || 1.0;
                        window.fadeGain.gain.value = oldVol;
                        
                        const fadeOut = setInterval(() => {
                            if (oldVol > 0.02) { oldVol -= 0.02; window.fadeGain.gain.value = oldVol; }
                            else { window.fadeGain.gain.value = 0; clearInterval(fadeOut); window.fadeAudio.pause(); }
                        }, 50);
                        
                        let newVol = 0;
                        window.audioSys.gain.gain.value = 0;
                        this.next(); // Load new track into main audio
                        
                        const fadeIn = setInterval(() => {
                            if (newVol < 1.0) { newVol += 0.02; window.audioSys.gain.gain.value = newVol; }
                            else { window.audioSys.gain.gain.value = 1.0; clearInterval(fadeIn); this.fading = false; }
                        }, 50);
                    }
                }
            }
            onEnd(){ if(this.loop)this.play(this.currId); else this.next(); }
            toggleRepeat(){ this.loop=!this.loop; window.$('btnLoop').style.color=this.loop?'var(--accent)':'inherit'; }
            loadSettings(){
                const b=localStorage.getItem('sv_bass'); if(b){document.querySelectorAll('.setting-slider')[1].value=b; window.audioSys.setBass(b);}
                const r=localStorage.getItem('sv_reverb'); if(r){document.querySelectorAll('.setting-slider')[2].value=r; window.audioSys.setReverb(r);}
                const p=localStorage.getItem('sv_pitch'); if(p){document.querySelectorAll('.setting-slider')[3].value=p; window.audioSys.setBaseSpeed(p);}
                const c=localStorage.getItem('sv_theme'); if(c) { window.ui.setTheme(c); if(window.$('colorPicker')) window.$('colorPicker').value = c; }
                const tm = localStorage.getItem('sv_theme_mode'); 
                if(tm) { 
                    window.ui.setThemeMode(tm); 
                    if(window.$('themeModeSelector')) window.$('themeModeSelector').value = tm; 
                } else {
                    window.ui.setThemeMode('solid');
                }
                const g1 = localStorage.getItem('sv_grad_1'); const g2 = localStorage.getItem('sv_grad_2');
                if(g1 && g2 && window.$('gradColor1') && window.$('gradColor2')) {
                    window.$('gradColor1').value = g1;
                    window.$('gradColor2').value = g2;
                }
                if(window.ui.updateGradientTheme) window.ui.updateGradientTheme();
                
                const font=localStorage.getItem('sv_font_family'); 
                if(font){ 
                    window.ui.setFontFamily(font); 
                    const fSel = window.$('fontSelector');
                    if(fSel) fSel.value = font;
                }
                const xtr=localStorage.getItem('sv_xtreme') === 'true'; window.$('xtremeToggle').checked=xtr; window.audioSys.toggleXtreme();
                const glob=localStorage.getItem('sv_global_audio') === 'true'; window.$('globalAudioToggle').checked=glob; window.audioSys.globalAudio=glob;
                const sync=localStorage.getItem('sv_party_sync'); if(sync){ if(window.$('syncOffsetSlider')) { window.$('syncOffsetSlider').value=sync; window.$('syncOffsetVal').innerText=sync+'ms'; } }
            }
        };

        class PartyMode {
            constructor() {
                this.active = false;
                this.sessionId = null;
                this.listeners = [];
                this.manualOffset = parseInt(localStorage.getItem('sv_party_sync')) || 0;
                this.peers = {};
                this.dataChannels = {};
                this.hostId = null;
            }
            toggleSetup() {
                const el = window.$('partySetupModal');
                if(el.style.display === 'none') { el.style.display = 'block'; this.updateUI(); } 
                else el.style.display = 'none';
            }
            updateUI() {
                if(this.active) {
                    window.$('partySetupInitial').style.display = 'none';
                    window.$('partySetupActive').style.display = 'block';
                    window.$('activePartyCode').innerText = this.sessionId;
                    window.$('syncLibraryBtn').style.display = 'block';
                } else {
                    window.$('partySetupInitial').style.display = 'block';
                    window.$('partySetupActive').style.display = 'none';
                    window.$('joinCodeInput').value = '';
                }
            }
            hostParty() {
                this.sessionId = Math.random().toString(36).substring(2,6).toUpperCase();
                this.isHost = true;
                this.connect();
            }
            joinParty() {
                const code = window.$('joinCodeInput').value.trim().toUpperCase();
                if(!code) return alert("Please enter a party code.");
                this.sessionId = code;
                this.isHost = false;
                this.connect();
            }
            connect() {
                if(this.active) this.leave();
                this.active = true;
                if(!window.player.myId) window.player.myId = crypto.randomUUID();
                
                window.$('partyBtn').classList.add('active');
                window.$('syncStatus').innerText = `Party: ${this.sessionId}`;
                window.$('syncStatus').style.display = 'inline-block';
                window.$('partyBtn').style.color = '#fbbf24';
                
                try {
                    const sessionRef = window.dbRef(window.db, 'sessions/' + this.sessionId);
                    const unsubscribe = window.onDbValue(sessionRef, (snapshot) => {
                        const data = snapshot.val();
                        if(data && data.sender !== window.player.myId) {
                            if (data.target && data.target !== window.player.myId) return;
                            this.handleMessage(data);
                        }
                    });
                    this.listeners.push(unsubscribe);
                    
                    if (this.isHost) {
                        this.pingInterval = setInterval(() => {
                            if (this.active && window.audioSys && window.audioSys.audio && !window.audioSys.audio.paused) {
                                this.broadcast({type: 'STATUS', playing: true, time: window.audioSys.audio.currentTime});
                            }
                        }, 3000);
                    }
                    
                    setTimeout(() => { 
                        this.broadcast({type: 'JOIN'}); 
                        window.ui.showToast("Joined session!"); 
                    }, 1000);
                } catch(e) { window.ui.showToast("Connection Error"); console.error("Party Mode error", e); }
                
                this.updateUI();
            }
            leave() {
                if (this.pingInterval) clearInterval(this.pingInterval);
                this.broadcast({type: 'LEAVE'});
                this.active = false;
                this.listeners.forEach(unsub => unsub());
                this.listeners = [];
                Object.values(this.peers).forEach(pc => pc.close());
                this.peers = {};
                this.dataChannels = {};
                window.$('partyBtn').classList.remove('active');
                window.$('partyBtn').style = '';
                window.$('syncStatus').style.display = 'none';
                this.updateUI();
                window.ui.showToast("Left Session");
            }
            broadcast(data) {
                if(!this.active || !window.db) return;
                const serverTime = Date.now() + (window.serverTimeOffset || 0);
                window.setDb(window.dbRef(window.db, 'sessions/' + this.sessionId), {
                    ...data, timestamp: serverTime, sender: window.player.myId
                });
            }
            updateCardProgress(id, pct) {
                const card = document.querySelector(`.lib-card[data-id="${id}"]`);
                if (card) {
                    let prog = card.querySelector('.sync-prog');
                    if (!prog) {
                        card.style.position = 'relative';
                        card.style.overflow = 'hidden';
                        prog = document.createElement('div');
                        prog.className = 'sync-prog';
                        prog.style = 'position:absolute; left:0; top:0; width:0%; height:100%; background:var(--accent); opacity:0.15; pointer-events:none; transition:width 0.1s linear, opacity 0.3s; z-index:0; border-radius:inherit;';
                        card.insertBefore(prog, card.firstChild);
                    }
                    prog.style.width = pct + '%';
                    prog.style.opacity = '0.2';
                    if (pct >= 100) {
                        setTimeout(() => { if (prog) prog.style.opacity = '0'; }, 800);
                    }
                }
            }

            initWebRTC(targetId) {
                if (this.peers[targetId]) return;
                const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
                this.peers[targetId] = pc;
                
                const dc = pc.createDataChannel("sync", { negotiated: true, id: 0 });
                dc.binaryType = "arraybuffer";
                this.dataChannels[targetId] = dc;
                
                let incomingChunks = [];
                let incomingMeta = null;
                
                dc.onmessage = async (e) => {
                    if (typeof e.data === 'string') {
                        const msg = JSON.parse(e.data);
                        if (msg.type === 'META') {
                            incomingMeta = msg;
                            incomingChunks = [];
                            window.$('syncStatus').innerText = "Downloading P2P...";
                        } else if (msg.type === 'DONE') {
                            const blob = new Blob(incomingChunks);
                            blob.name = incomingMeta.name + ".mp3";
                            this.updateCardProgress(incomingMeta.id, 100);
                            
                            await window.player.db.add(blob, {beatSignals: incomingMeta.beatSignals, speedPoints: incomingMeta.speedPoints});
                            await window.player.loadLib();
                            
                            incomingChunks = [];
                            
                            if (incomingMeta.playImmediately) {
                                window.player.play(incomingMeta.id, null, false);
                                this.broadcast({type: 'READY', id: incomingMeta.id, target: this.hostId});
                            }
                            
                            incomingMeta = null;
                            const status = window.$('syncStatus');
                            status.innerText = `Party: ${this.sessionId}`;
                        } else if (msg.type === 'SYNC_ALL_DONE') {
                            window.ui.showToast("Library Sync Complete!");
                            window.$('syncStatus').innerText = `Party: ${this.sessionId}`;
                        } else if (msg.type === 'NO_SYNC_NEEDED') {
                            window.ui.showToast("All tracks already synced!");
                        }
                    } else {
                        incomingChunks.push(e.data);
                        if (incomingMeta) {
                            const pct = Math.round((incomingChunks.length / incomingMeta.totalChunks) * 100);
                            window.$('syncStatus').innerText = `Receiving: ${pct}%`;
                            this.updateCardProgress(incomingMeta.id, pct);
                        }
                    }
                };

                pc.onicecandidate = e => {
                    if (e.candidate) this.broadcast({ type: 'ICE', target: targetId, candidate: JSON.stringify(e.candidate) });
                };

                if (this.isHost) {
                    pc.createOffer().then(offer => pc.setLocalDescription(offer)).then(() => {
                        this.broadcast({ type: 'OFFER', target: targetId, sdp: JSON.stringify(pc.localDescription) });
                    });
                }
            }

            async streamFileToDC(dc, s, playImmediately = false) {
                return new Promise((resolve) => {
                    const reader = new FileReader();
                    reader.onload = async (e) => {
                        const buffer = e.target.result;
                        const chunkSize = 64 * 1024; // 64KB chunks for reliable WebRTC routing
                        const totalChunks = Math.ceil(buffer.byteLength / chunkSize);
                        
                        dc.send(JSON.stringify({
                            type: 'META', id: s.id, name: s.name, totalChunks,
                            beatSignals: s.beatSignals || [], speedPoints: s.speedPoints || [],
                            playImmediately
                        }));
                        
                        for(let i=0; i<totalChunks; i++) {
                            const start = i * chunkSize;
                            const end = Math.min(start + chunkSize, buffer.byteLength);
                            const chunk = buffer.slice(start, end);
                            
                            // WebRTC backpressure handling
                            while(dc.bufferedAmount > 1024 * 1024) { 
                                await new Promise(r => setTimeout(r, 10)); // throttle to 1MB buffer limit
                            }
                            dc.send(chunk);
                            
                            const pct = Math.round(((i+1)/totalChunks)*100);
                            window.$('syncStatus').innerText = `Sending: ${pct}%`;
                            this.updateCardProgress(s.id, pct);
                        }
                        
                        dc.send(JSON.stringify({ type: 'DONE', id: s.id }));
                        window.$('syncStatus').innerText = `Party: ${this.sessionId}`;
                        resolve();
                    };
                    reader.readAsArrayBuffer(s.blob);
                });
            }

            syncLibrary() {
                if (!this.active) return;
                if (this.isHost) {
                    const manifest = window.player.songs.map(s => s.id);
                    this.broadcast({ type: 'MANIFEST', ids: manifest });
                    window.ui.showToast("Broadcasted Library to Clients...");
                } else {
                    this.broadcast({type: 'REQ_MANIFEST'});
                    window.ui.showToast("Requested full sync from Host...");
                }
            }

            async broadcastInChunks(song) {
                if (!window.db || !this.sessionId || !this.isHost) return;
                this.broadcast({ type: 'PLAY', id: song.id, name: song.name, beatSignals: song.beatSignals || [], speedPoints: song.speedPoints || [] });
                
                for (const [targetId, dc] of Object.entries(this.dataChannels)) {
                    if (dc.readyState === "open") {
                        this.streamFileToDC(dc, song, true);
                    }
                }
            }

            handleMessage(data) {
                if(data.type === 'JOIN' && this.isHost) {
                    window.ui.showToast("User Connected via WebRTC!");
                    this.initWebRTC(data.sender);
                }
                if(data.type === 'LEAVE') {
                    window.ui.showToast("User Disconnected");
                    if (this.peers[data.sender]) {
                        this.peers[data.sender].close();
                        delete this.peers[data.sender];
                        delete this.dataChannels[data.sender];
                    }
                }
                
                if(data.type === 'OFFER' && !this.isHost) {
                    this.hostId = data.sender;
                    this.initWebRTC(data.sender);
                    const pc = this.peers[data.sender];
                    pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.sdp)))
                      .then(() => pc.createAnswer())
                      .then(answer => pc.setLocalDescription(answer))
                      .then(() => this.broadcast({ type: 'ANSWER', target: data.sender, sdp: JSON.stringify(pc.localDescription) }));
                }
                if(data.type === 'ANSWER' && this.isHost) {
                    const pc = this.peers[data.sender];
                    if (pc) pc.setRemoteDescription(new RTCSessionDescription(JSON.parse(data.sdp)));
                }
                if(data.type === 'ICE') {
                    const pc = this.peers[data.sender];
                    if (pc) pc.addIceCandidate(new RTCIceCandidate(JSON.parse(data.candidate)));
                }

                if (data.type === 'REQ_MANIFEST' && this.isHost) {
                    const manifest = window.player.songs.map(s => s.id);
                    this.broadcast({ type: 'MANIFEST', target: data.sender, ids: manifest });
                }
                if (data.type === 'MANIFEST' && !this.isHost) {
                    const missing = data.ids.filter(id => !window.player.songs.some(s => s.id === id));
                    this.broadcast({ type: 'WANT_LIST', target: data.sender, missing });
                }
                if (data.type === 'WANT_LIST' && this.isHost) {
                    const dc = this.dataChannels[data.sender];
                    if (dc && dc.readyState === "open") {
                        if (data.missing.length === 0) {
                            dc.send(JSON.stringify({ type: 'NO_SYNC_NEEDED' }));
                            return;
                        }
                        window.ui.showToast("Syncing " + data.missing.length + " missing tracks to Client!");
                        const pushSeq = async () => {
                            for (const id of data.missing) {
                                const s = window.player.songs.find(x => x.id === id);
                                if (s) await this.streamFileToDC(dc, s, false);
                            }
                            dc.send(JSON.stringify({ type: 'SYNC_ALL_DONE' }));
                        };
                        pushSeq();
                    } else {
                        window.ui.showToast("P2P Tunnel not ready yet! Try again in 5 sec.");
                    }
                }

                if(data.type === 'PLAY') {
                    this.lastCommandId = data.id;
                    let song = window.player.songs.find(s => s.id === data.id || s.name === data.name || (s.name && s.name.replace('.mp3','') === data.name.replace('.mp3','')));
                    if (song) {
                        if (window.player.currId !== song.id) {
                            window.ui.showToast("Switching: " + song.name);
                            if(data.beatSignals) song.beatSignals = data.beatSignals;
                            if(data.speedPoints) song.speedPoints = data.speedPoints;
                            window.player.play(song.id, null, false);
                            this.broadcast({type: 'READY', id: data.id, target: data.sender});
                        }
                    } else if (!this.isHost) {
                        window.ui.showToast("Buffering track via P2P...");
                    }
                }
                else if (data.type === 'READY' && this.isHost && data.id === this.lastCommandId) {
                    window.ui.hideSyncPopup();
                    window.audioSys.audio.play();
                    window.ui.updatePlayBtn(true);
                    const finalStatus = window.$('syncStatus');
                    if (finalStatus) finalStatus.innerText = `Party: ${this.sessionId}`;
                }
                else if(data.type === 'STATUS') {
                    if(data.playing && window.audioSys.audio.paused) window.player.togglePlay();
                    else if(!data.playing && !window.audioSys.audio.paused) window.player.togglePlay();
                    
                    if (data.time && data.timestamp) {
                        const localServerTime = Date.now() + (window.serverTimeOffset || 0);
                        const latency = Math.max(0, (localServerTime - data.timestamp) / 1000);
                        const expectedTime = data.time + latency + (this.manualOffset / 1000);
                        const drift = expectedTime - window.audioSys.audio.currentTime;

                        if (Math.abs(drift) > 0.3) {
                            window.audioSys.audio.currentTime = expectedTime;
                            window.audioSys.audio.playbackRate = window.audioSys.baseSpeed || 1.0;
                        } 
                        else if (Math.abs(drift) > 0.02) {
                            const slewRate = drift > 0 ? 1.05 : 0.95;
                            window.audioSys.audio.playbackRate = (window.audioSys.baseSpeed || 1.0) * slewRate;
                        } else {
                            window.audioSys.audio.playbackRate = window.audioSys.baseSpeed || 1.0;
                        }
                    }
                }
                else if (data.type === 'FX_SYNC' && !this.isHost) {
                    const sl = document.querySelectorAll('.setting-slider');
                    if (data.bass !== undefined) { sl[1].value = data.bass; window.audioSys.setBass(data.bass); }
                    if (data.reverb !== undefined) { sl[2].value = data.reverb; window.audioSys.setReverb(data.reverb); }
                    if (data.speed !== undefined) { sl[3].value = data.speed; window.audioSys.setBaseSpeed(data.speed); }
                    if (data.xtreme !== undefined) { window.$('xtremeToggle').checked = data.xtreme; window.audioSys.toggleXtreme(); }
                    window.ui.showToast("Host adjusted audio FX");
                }
            }
        };

        class VoiceCommander {
            constructor() {
                this.listening = false;
                this.rec = null;
                if ('webkitSpeechRecognition' in window) {
                    this.rec = new webkitSpeechRecognition();
                    this.rec.continuous = true;
                    this.rec.interimResults = false;
                    this.rec.onresult = (e) => this.handleResult(e);
                    this.rec.onend = () => { if(this.listening) this.rec.start(); };
                }
            }
            toggle() {
                if(!this.rec) return alert("Voice control not supported in this browser.");
                this.listening = !this.listening;
                if(this.listening) { this.rec.start(); document.getElementById('micBtn').classList.add('listening'); }
                else { this.rec.stop(); document.getElementById('micBtn').classList.remove('listening'); }
            }
            handleResult(e) {
                const transcript = e.results[e.results.length-1][0].transcript.toLowerCase();
                if(transcript.includes('play') || transcript.includes('start')) window.player.togglePlay();
                else if(transcript.includes('pause') || transcript.includes('stop')) window.player.togglePlay();
                else if(transcript.includes('next') || transcript.includes('skip') || transcript.includes('slip')) window.player.next();
                else if(transcript.includes('back') || transcript.includes('previous') || transcript.includes('prev')) window.player.prev();
            }
        };

        // --- GLOBAL ASSIGNMENTS ---
        window.AudioExporter = AudioExporter;
        window.MusicDB = MusicDB;
        window.LibraryManager = LibraryManager;
        window.AudioSystem = AudioSystem;
        window.Visualizer = Visualizer;
        window.CurveEditor = CurveEditor;
        window.UI = UI;
        window.Player = Player;
        window.VoiceCommander = VoiceCommander;

        // --- INSTANTIATION ---
        window.libraryMgr = new LibraryManager();
        window.audioSys = new AudioSystem();
        window.viz = new Visualizer();
        window.ui = new UI();
        window.player = new Player();
        window.curveEditor = new CurveEditor();
        window.voiceControl = new VoiceCommander();
        window.exporter = new AudioExporter(); 
        window.partyMode = new PartyMode();

        const urlParams = new URLSearchParams(window.location.search);
        const playlistParam = urlParams.get('playlist');
        if(playlistParam && window.libraryMgr) {
            setTimeout(() => window.libraryMgr.loadSharedLibrary(playlistParam), 1500);
        }

        // DPPD Setup
        window.updateDPPD = function() {
            const sens = parseFloat(document.getElementById('dppdSensSlider').value);
            const gap = parseFloat(document.getElementById('dppdGapSlider').value);
            const algoData = {
                version: "2.0-DPPD-Manual",
                learnedAt: Date.now(),
                minGap: gap,
                threshold: sens / 7.0, // Scale back to the 0.0-1.0 range internally
                frequencyBand: "Full Spectrum (RMS Decimated)"
            };
            localStorage.setItem('okmusic_bass_algorithm', JSON.stringify(algoData));
        };
        
        window.initDPPDSliders = function() {
            const cached = localStorage.getItem('okmusic_bass_algorithm');
            if(cached) {
                try {
                    const parsed = JSON.parse(cached);
                    const sensSlider = document.getElementById('dppdSensSlider');
                    const gapSlider = document.getElementById('dppdGapSlider');
                    if(parsed.threshold && sensSlider) {
                        const sensDisplay = (parsed.threshold * 7.0).toFixed(1);
                        sensSlider.value = sensDisplay;
                        if(document.getElementById('dppdSensVal')) document.getElementById('dppdSensVal').innerText = sensDisplay;
                    }
                    if(parsed.minGap && gapSlider) {
                        const gapDisplay = parsed.minGap;
                        gapSlider.value = gapDisplay;
                        if(document.getElementById('dppdGapVal')) document.getElementById('dppdGapVal').innerText = gapDisplay + 's';
                    }
                } catch(e) {}
            }
        };
        setTimeout(() => window.initDPPDSliders(), 500);

        // PWA SERVICE WORKER
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js').then(reg => {
                    console.log('SW registered!', reg);
                }).catch(err => console.log('SW failed', err));
            });
        }
