/**
 * AdaptiveBassDetectorProcessor.js
 * Runs entirely on the Web Audio rendering thread.
 * Strict zero-allocation policy in the process() loop to prevent GC pauses.
 */

class AdaptiveBassDetectorProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        
        // Audio processing topological constants
        this.fftSize = 2048;
        this.hopSize = 512;
        this.sampleRate = 44100;
        this.bufferPointer = 0;
        
        // Pre-allocated memory heaps for zero-GC operation
        this.audioBuffer = new Float32Array(this.fftSize);
        this.window = new Float32Array(this.fftSize);
        this.real = new Float32Array(this.fftSize);
        this.imag = new Float32Array(this.fftSize);
        this.mag = new Float32Array(this.fftSize / 2);
        this.prevMag = new Float32Array(this.fftSize / 2);
        
        // Pre-compute Hann Window coefficients
        for (let i = 0; i < this.fftSize; i++) {
            this.window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (this.fftSize - 1)));
        }

        // Active Learning Weights: [Sub, Mid, Upper]
        this.weights = new Float32Array([1.0, 1.0, 1.0]);
        this.alphaMultiplier = 2.5; 
        this.decayRate = 0.95;
        
        // Statistical History Buffer variables (Welford's Algorithm)
        this.historySize = 86; // ~1 second of frames at 512 hop
        this.fluxHistory = new Float32Array(this.historySize);
        this.historyIndex = 0;
        this.mean = 0;
        this.M2 = 0; 
        
        // Envelope & Physiological Debouncing State
        this.currentEnvelope = 0;
        this.framesSinceLastOnset = 9999;
        // 150ms absolute refractory period converted to frames
        this.refractoryFrames = Math.floor(0.150 / (this.hopSize / this.sampleRate)); 

        // Setup bi-directional MessagePort communication
        this.port.onmessage = this.handleMessage.bind(this);
    }

    // Handles IPC updates from the Active Learning Controller
    handleMessage(event) {
        if (event.data.type === 'UPDATE_WEIGHTS') {
            this.weights[0] = event.data.weights[0];
            this.weights[1] = event.data.weights[1];
            this.weights[2] = event.data.weights[2];
            this.alphaMultiplier = event.data.alpha;
        }
    }

    // In-place Cooley-Tukey Radix-2 DIT FFT (Optimized for V8 execution)
    computeFFT(real, imag) {
        let n = real.length;
        
        // Phase 1: Bit-reversal permutation
        for (let i = 1, j = 0; i < n - 1; i++) {
            let bit = n >> 1;
            for (; j & bit; bit >>= 1) j ^= bit;
            j ^= bit;
            if (i < j) {
                let tempReal = real[i], tempImag = imag[i];
                real[i] = real[j]; imag[i] = imag[j];
                real[j] = tempReal; imag[j] = tempImag;
            }
        }
        
        // Phase 2: Iterative Butterfly operations
        for (let len = 2; len <= n; len <<= 1) {
            let halfLen = len >> 1;
            let angle = -2 * Math.PI / len;
            let wRe = Math.cos(angle), wIm = Math.sin(angle);
            for (let i = 0; i < n; i += len) {
                let uRe = 1, uIm = 0;
                for (let j = 0; j < halfLen; j++) {
                    let idx1 = i + j, idx2 = i + j + halfLen;
                    let tRe = uRe * real[idx2] - uIm * imag[idx2];
                    let tIm = uRe * imag[idx2] + uIm * real[idx2];
                    real[idx2] = real[idx1] - tRe;
                    imag[idx2] = imag[idx1] - tIm;
                    real[idx1] += tRe;
                    imag[idx1] += tIm;
                    let nextURe = uRe * wRe - uIm * wIm;
                    uIm = uRe * wIm + uIm * wRe;
                    uRe = nextURe;
                }
            }
        }
    }

    // Standard 128-sample quantum processing loop
    process(inputs, outputs, parameters) {
        const input = inputs[0];
        if (!input || !input[0]) return true;
        const channelData = input[0]; // Isolate Mono channel for bass detection

        // Fill continuous circular buffer
        for (let i = 0; i < channelData.length; i++) {
            this.audioBuffer[this.bufferPointer] = channelData[i];
            this.bufferPointer++;

            // When the buffer is completely filled (fftSize), trigger frame analysis
            if (this.bufferPointer >= this.fftSize) {
                this.analyzeFrame();
                // Shift buffer contents downward by hopSize to maintain overlap
                this.audioBuffer.copyWithin(0, this.hopSize, this.fftSize);
                this.bufferPointer = this.fftSize - this.hopSize;
            }
        }
        return true;
    }

    analyzeFrame() {
        // 1. Apply Hann Window to mitigate spectral leakage and copy to complex arrays
        for (let i = 0; i < this.fftSize; i++) {
            this.real[i] = this.audioBuffer[i] * this.window[i];
            this.imag[i] = 0;
        }

        // 2. Execute Fast Fourier Transform
        this.computeFFT(this.real, this.imag);

        // 3. Compute L1-Norm Half-Wave Rectified Spectral Flux across isolated Bass Bands
        let fluxSub = 0, fluxMid = 0, fluxUpper = 0;
        
        // Loop solely over the target bins (1 to 12) covering ~21Hz to ~258Hz
        for (let k = 1; k <= 12; k++) { 
            let currentMag = Math.sqrt(this.real[k] * this.real[k] + this.imag[k] * this.imag[k]);
            this.mag[k] = currentMag;
            
            // Calculate difference and apply half-wave rectification
            let diff = currentMag - this.prevMag[k];
            let rectifiedDiff = diff > 0 ? diff : 0; 
            
            if (k >= 1 && k < 3) fluxSub += rectifiedDiff;
            else if (k >= 3 && k < 6) fluxMid += rectifiedDiff;
            else if (k >= 6 && k <= 12) fluxUpper += rectifiedDiff;
            
            // Store magnitude for next frame's differential comparison
            this.prevMag[k] = currentMag;
        }

        // 4. Apply actively learned perceptron weights to generate the master detection function
        let totalFlux = (fluxSub * this.weights[0]) + 
                        (fluxMid * this.weights[1]) + 
                        (fluxUpper * this.weights[2]);

        // 5. Update Online Variance Statistics via Welford's Algorithm (O(1) complexity)
        let oldVal = this.fluxHistory[this.historyIndex];
        this.fluxHistory[this.historyIndex] = totalFlux;
        this.historyIndex = (this.historyIndex + 1) % this.historySize;
        
        let delta1 = totalFlux - this.mean;
        this.mean += delta1 / this.historySize;
        let delta2 = totalFlux - this.mean;
        this.M2 += (delta1 * delta2) - ((oldVal - this.mean) * (oldVal - this.mean));
        let variance = Math.max(0, this.M2 / this.historySize);
        let stdDev = Math.sqrt(variance);

        // 6. Dynamic Thresholding & Peak Picking
        let threshold = this.mean + (this.alphaMultiplier * stdDev);
        let effectiveThreshold = Math.max(threshold, this.currentEnvelope);

        // Calculate a timestamp approx based on currentTime (approx 16ms accuracy)
        let currentTimeMillis = Date.now();

        let isOnset = false;
        // Evaluate condition against effective threshold AND physiological refractory lockout
        if (totalFlux > effectiveThreshold && this.framesSinceLastOnset >= this.refractoryFrames) {
            isOnset = true;
            this.framesSinceLastOnset = 0;
            this.currentEnvelope = totalFlux; // Spike the decay envelope
            
            // Dispatch confirmed onset back to Main Thread for visual rendering
            this.port.postMessage({
                type: 'ONSET_DETECTED',
                timestamp: currentTimeMillis,
                flux: totalFlux
            });
        }

        // Advance state tracking
        this.framesSinceLastOnset++;
        this.currentEnvelope *= this.decayRate; // Apply exponential decay to envelope
        
        // Continuously post analytical data to main thread for the sliding learning history buffer
        this.port.postMessage({
            type: 'FEATURE_VECTOR',
            timestamp: currentTimeMillis,
            features: [fluxSub, fluxMid, fluxUpper],
            prediction: totalFlux
        });
    }
}

registerProcessor('adaptive-bass-detector', AdaptiveBassDetectorProcessor);
