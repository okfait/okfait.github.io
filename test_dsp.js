const fs = require('fs');
let code = fs.readFileSync('assets/js/bass-worklet.js', 'utf8');
code = code.replace('class AdaptiveBassDetectorProcessor extends AudioWorkletProcessor', 'class AdaptiveBassDetectorProcessor');
code = code.replace('registerProcessor', '////');
code = code.replace('super();', '');

eval(code);

const dsp = new AdaptiveBassDetectorProcessor();
dsp.port = { postMessage: () => {} };

const channelData = new Float32Array(128);
for(let i=0; i<128; i++) channelData[i] = Math.random() * 2 - 1;

let start = performance.now();
for(let i=0; i<44100/128; i++) {
    dsp.process([[channelData]]);
}
let end = performance.now();
console.log('Processed 1 second of audio in:', (end - start).toFixed(2), 'ms');
