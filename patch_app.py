import re

with open('assets/js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Define the LearningController
learning_controller_code = """
class okMUSICLearningController {
    constructor(audioNode) {
        this.workletNode = audioNode;
        this.learningRate = 0.05; // Eta for SGD
        this.alphaLearningRate = 0.1; // Gamma step for the sensitivity multiplier
        
        // State variables mirroring the Worklet architecture
        this.weights = new Float32Array([1.0, 1.0, 1.0]); 
        this.alphaMultiplier = 2.5;

        // Temporal history buffer to align human reaction time with specific audio frames
        this.featureHistory = [];
        this.maxHistoryLength = 50; // Caches roughly 500ms of frames (50 * 11.6ms)
        
        // Load persisted state if exists
        this.loadState();

        // Listen for data emitted from the AudioWorklet
        this.workletNode.port.onmessage = (event) => {
            if (event.data.type === 'FEATURE_VECTOR') {
                this.cacheFeatureVector(event.data);
            }
            if (event.data.type === 'ONSET_DETECTED') {
                this.triggerVisuals(event.data.flux); 
            }
        };
        
        this.syncWithWorklet();
    }

    triggerVisuals(flux) {
        // Visual indicator logic will go here if needed
        const dot = document.getElementById('beat-indicator');
        if (dot) {
            dot.style.opacity = '1';
            dot.style.transform = 'scale(1.5)';
            setTimeout(() => {
                dot.style.opacity = '0.3';
                dot.style.transform = 'scale(1)';
            }, 100);
        }
    }

    cacheFeatureVector(data) {
        this.featureHistory.push(data);
        if (this.featureHistory.length > this.maxHistoryLength) {
            this.featureHistory.shift();
        }
    }

    // Invoked when user clicks "Teach True Beat" (Handling a False Negative)
    teachTrueBeat() {
        if(this.featureHistory.length === 0) return;
        let targetFrame = this.featureHistory.reduce((prev, current) => {
            return (prev.prediction > current.prediction)? prev : current;
        });
        this.applyGradientDescent(targetFrame.features, targetFrame.prediction, 1.0);
        this.alphaMultiplier = Math.max(1.0, this.alphaMultiplier - this.alphaLearningRate);
        this.syncWithWorklet();
        this.saveState();
        console.log("Taught TRUE BEAT", this.weights, this.alphaMultiplier);
    }

    // Invoked when user clicks "Teach Error" (Handling a False Positive)
    teachFalsePositive() {
        if(this.featureHistory.length === 0) return;
        let targetFrame = this.featureHistory[this.featureHistory.length - 1];
        this.applyGradientDescent(targetFrame.features, targetFrame.prediction, 0.0);
        this.alphaMultiplier = Math.min(5.0, this.alphaMultiplier + (this.alphaLearningRate * 2));
        this.syncWithWorklet();
        this.saveState();
        console.log("Taught FALSE POSITIVE", this.weights, this.alphaMultiplier);
    }

    applyGradientDescent(features, prediction, yTrue) {
        let maxFeature = Math.max(features[0], features[1], features[2], 0.0001);
        let x = features.map(f => f / maxFeature);
        let error = yTrue - prediction;
        for (let i = 0; i < this.weights.length; i++) {
            this.weights[i] += this.learningRate * error * x[i];
            this.weights[i] = Math.max(0.1, this.weights[i]); 
        }
    }

    syncWithWorklet() {
        this.workletNode.port.postMessage({
            type: 'UPDATE_WEIGHTS',
            weights: [this.weights[0], this.weights[1], this.weights[2]],
            alpha: this.alphaMultiplier
        });
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
                    console.log("Loaded saved learning state for track");
                } catch(e) {}
            }
        }
    }
}
"""

# Replace init() inside AudioSystem
new_init = """
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
"""

content = content.replace("class AudioSystem {", learning_controller_code + "\n        class AudioSystem {")

# find the exact string for init() to replace
old_init_regex = re.compile(r'init\(\) \{ if\(this\.ctx\)return; const AC=window\.AudioContext\|\|window\.webkitAudioContext;.*window\.viz\.start\(\); \}')
content = old_init_regex.sub(new_init.strip(), content)

with open('assets/js/app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Patched app.js successfully.")
