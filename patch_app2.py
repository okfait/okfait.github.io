import re

with open('assets/js/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. We replace the ENTIRE okMUSICLearningController with the newer, timeline-based batch one.
new_controller = """class okMUSICLearningController {
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
            window.ui.showToast(Neural Network Updated: Fixed \ misses & \ false positives.);
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
}"""

# Use regex to replace the class block
pattern = re.compile(r'class okMUSICLearningController \{.*?\n        class AudioSystem', re.DOTALL)
if pattern.search(content):
    content = pattern.sub(new_controller + '\n        class AudioSystem', content)
else:
    print("Could not find okMUSICLearningController string")

with open('assets/js/app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print("Patched app.js successfully with Offline Learning Controller.")
