import re

with open('assets/js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. We replace the ENTIRE okMUSICLearningController with the newer, AnalyserNode-based one.
new_controller = """class okMUSICLearningController {
    constructor() {
        this.learningRate = 0.05; 
        this.alphaLearningRate = 0.1; 
        
        this.weights = new Float32Array([1.0, 1.0, 1.0]); 
        this.alphaMultiplier = 2.5;

        this.featureHistory = [];
        this.maxHistoryLength = 4000; 

        // AnalyserNode Stats
        this.historySize = 86;
        this.fluxHistory = new Float32Array(this.historySize);
        this.historyIndex = 0;
        this.mean = 0;
        this.M2 = 0;
        
        this.prevMag = new Float32Array(1024); // Based on 2048 FFT
        
        this.currentEnvelope = 0;
        this.decayRate = 0.95;
        this.framesSinceLastOnset = 9999;
        this.refractoryFrames = 12; // Roughly 150ms at 86 fps
        
        this.loadState();
    }

    // Called ~60 times a second by the Visualizer requestAnimationFrame loop
    // Replaces the AudioWorklet entirely, running entirely on main thread pulling from C++ node
    processFrame(analyser) {
        if(!analyser || window.audioSys.audio.paused) return;
        
        const dataLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(dataLength);
        analyser.getByteFrequencyData(dataArray);

        let fluxSub = 0, fluxMid = 0, fluxUpper = 0;
        
        // Target bins covering ~20Hz to ~250Hz (Roughly bins 1 to 12 at 44.1kHz with 2048 FFT)
        for (let k = 1; k <= 12; k++) { 
            let currentMag = dataArray[k];
            let diff = currentMag - this.prevMag[k];
            let rectifiedDiff = diff > 0 ? diff : 0; 
            
            if (k >= 1 && k < 3) fluxSub += rectifiedDiff;
            else if (k >= 3 && k < 6) fluxMid += rectifiedDiff;
            else if (k >= 6 && k <= 12) fluxUpper += rectifiedDiff;
            
            this.prevMag[k] = currentMag;
        }

        let totalFlux = (fluxSub * this.weights[0]) + 
                        (fluxMid * this.weights[1]) + 
                        (fluxUpper * this.weights[2]);

        // Welford's Online Variance
        let oldVal = this.fluxHistory[this.historyIndex];
        this.fluxHistory[this.historyIndex] = totalFlux;
        this.historyIndex = (this.historyIndex + 1) % this.historySize;
        
        let delta1 = totalFlux - this.mean;
        this.mean += delta1 / this.historySize;
        let delta2 = totalFlux - this.mean;
        this.M2 += (delta1 * delta2) - ((oldVal - this.mean) * (oldVal - this.mean));
        let variance = Math.max(0, this.M2 / this.historySize);
        let stdDev = Math.sqrt(variance);

        let threshold = this.mean + (this.alphaMultiplier * stdDev);
        let effectiveThreshold = Math.max(threshold, this.currentEnvelope);

        if (totalFlux > effectiveThreshold && this.framesSinceLastOnset >= this.refractoryFrames) {
            this.framesSinceLastOnset = 0;
            this.currentEnvelope = totalFlux; 
            
            // Visual feedback
            if(window.curveEditor && window.curveEditor.isOpen) {
                window.curveEditor.pulse = 1.0;
            }
        }

        this.framesSinceLastOnset++;
        this.currentEnvelope *= this.decayRate;

        // Cache features for timeline offline learning
        if (totalFlux > this.mean * 0.5 || this.framesSinceLastOnset % 5 === 0) {
            this.featureHistory.push({
                trackTime: window.audioSys.audio.currentTime,
                features: [fluxSub, fluxMid, fluxUpper],
                prediction: totalFlux
            });
            if (this.featureHistory.length > this.maxHistoryLength) {
                this.featureHistory.shift();
            }
        }
    }

    learnFromTimeline(userBeatSignals) {
        console.log("Analyzing " + userBeatSignals.length + " user beats against " + this.featureHistory.length + " cached frames...");
        
        let falseNegatives = 0;
        let falsePositives = 0;

        for(let ub of userBeatSignals) {
            let userTime = ub.time || ub; 
            let closestFrame = this.featureHistory.reduce((prev, curr) => {
                return (Math.abs(curr.trackTime - userTime) < Math.abs(prev.trackTime - userTime)) ? curr : prev;
            }, this.featureHistory[0]);

            if (closestFrame && Math.abs(closestFrame.trackTime - userTime) < 0.2) {
                this.applyGradientDescent(closestFrame.features, closestFrame.prediction, 1.0);
                this.alphaMultiplier = Math.max(1.0, this.alphaMultiplier - (this.alphaLearningRate * 0.5));
                falseNegatives++;
            }
        }

        for(let frame of this.featureHistory) {
            let predictedScore = (frame.features[0] * this.weights[0]) + (frame.features[1] * this.weights[1]) + (frame.features[2] * this.weights[2]);
            if (predictedScore > 0.05) { 
                let isNearUserPoint = userBeatSignals.some(ub => {
                    let userTime = ub.time || ub;
                    return Math.abs(frame.trackTime - userTime) < 0.25;
                });

                if (!isNearUserPoint) {
                    this.applyGradientDescent(frame.features, predictedScore, 0.0);
                    this.alphaMultiplier = Math.min(5.0, this.alphaMultiplier + (this.alphaLearningRate * 0.1));
                    falsePositives++;
                }
            }
        }
        
        this.saveState();
        if(window.ui && window.ui.showToast) {
            window.ui.showToast(Neural Network Updated: Fixed \ misses & \ false positives.);
        }
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

    saveState() {
        if(window.player && window.player.currentTrack) {
            const trackId = window.player.currentTrack.id;
            const state = { weights: [this.weights[0], this.weights[1], this.weights[2]], alphaMultiplier: this.alphaMultiplier };
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
                } catch(e) {}
            }
        }
    }
}"""

# 2. Patch out the AudioWorklet loading in AudioSystem.init()
pattern = re.compile(r'class okMUSICLearningController \{.*?\n        class AudioSystem', re.DOTALL)
if pattern.search(content):
    content = pattern.sub(new_controller + '\n        class AudioSystem', content)

# 3. Patch out AudioWorklet injection logic
worklet_pattern = re.compile(r'try \{\s+await this\.ctx\.audioWorklet\.addModule\(\'assets/js/bass-worklet\.js\'\);\s+this\.bassDetectorNode = new AudioWorkletNode\(this\.ctx, \'adaptive-bass-detector\'\);\s+this\.src\.connect\(this\.bassDetectorNode\);\s+this\.learningController = new okMUSICLearningController\(this\.bassDetectorNode\);\s+window\.learningController = this\.learningController;\s+console\.log\("Advanced Bass Detection AudioWorklet injected\."\);\s+\} catch\(e\) \{\s+console\.error\("AudioWorklet failed to load:", e\);\s+\}')
if worklet_pattern.search(content):
    content = worklet_pattern.sub("this.learningController = new okMUSICLearningController();\n                    window.learningController = this.learningController;\n                    console.log(\"Advanced Native AnalyserNode Bass Detection initialized.\");", content)

with open('assets/js/app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Patched app.js successfully with Native AnalyserNode Controller.")
