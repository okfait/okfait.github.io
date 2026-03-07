import re

with open('assets/js/app.js', 'r', encoding='utf-8') as f:
    code = f.read()

replacement = """
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
"""

start_idx = code.find('            getSymmetricPoints(cx, cy, frameData) {')
end_str = '                ctx.fill(mainPath);\n            }'
end_idx = code.find(end_str, start_idx) + len(end_str)

if start_idx != -1 and end_idx != -1:
    new_code = code[:start_idx] + replacement.strip() + code[end_idx:]
    with open('assets/js/app.js', 'w', encoding='utf-8') as f:
        f.write(new_code)
    print("PATCH SUCCESSFUL")
else:
    print("COULD NOT FIND INDICES", start_idx, end_idx)
