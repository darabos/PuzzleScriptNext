'use strict';

/**
 * PuzzleScript 3D Renderer using Three.js
 *
 * This module replaces the traditional 2D canvas rendering with a 3D WebGL renderer.
 * Each pixel in the original sprites becomes a cube in 3D space.
 */

// Three.js globals
let renderer3d = null;
let scene3d = null;
let camera3d = null;
let container3d = null;  // The DOM container element
let cubeGeometry = null;
let cubeMaterials = {};  // Cache materials by color
let use3DRenderer = true; // Toggle between 2D and 3D rendering
let groundPlane = null;  // Ground plane to receive shadows

// Mesh caching for performance - avoid removing/re-adding meshes
let meshCache = {};      // key -> { mesh, inUse }
let levelGroup = null;   // THREE.Group to hold all level meshes
let lastLevelId = null;  // Track level identity for cache invalidation

// Three-point lighting system
let keyLight = null;     // Main shadow-casting light (warm)
let fillLight = null;    // Soft fill light (cool)
let backLight = null;    // Rim/back light for edge definition

// Animation system
let previousLevelState = null;  // Snapshot of level.objects before move
let animationStartTime = 0;     // When current animation started
let animationDuration = 100;    // Duration in ms for slide animation
let isAnimating = false;        // Whether an animation is in progress
let animatedMeshes = [];        // Meshes that are being animated with their start/end positions
let animationFrameId = null;    // requestAnimationFrame ID

// Camera settings
const CAMERA_FOV = 40;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1000;
const CUBE_SIZE = 1;
const CAMERA_DISTANCE = 6;

// Camera position and rotation
let cameraDistance = CAMERA_DISTANCE;
let cameraAngleX = 1.2;
let cameraAngleY = 0.0;

/**
 * Initialize the Three.js renderer, scene, and camera
 */
function init3DRenderer() {
    if (!window.THREE) {
        console.error('Three.js not loaded! Falling back to 2D renderer.');
        use3DRenderer = false;
        return false;
    }

    // Get the canvas container - try different selectors for play.html vs editor.html
    let container = document.querySelector('.gameContainer');
    if (!container) {
        container = document.querySelector('.upperarea');
    }
    if (!container) {
        // Final fallback: use the parent of the 2D canvas
        const canvas2d = document.getElementById('gameCanvas');
        container = canvas2d ? canvas2d.parentElement : null;
    }
    if (!container) {
        console.error('Game container not found!');
        use3DRenderer = false;
        return false;
    }

    // Store container reference for resize handling
    container3d = container;

    // Create the WebGL renderer
    renderer3d = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true
    });
    renderer3d.setPixelRatio(window.devicePixelRatio);
    renderer3d.setSize(container.clientWidth, container.clientHeight);
    renderer3d.setClearColor(0x000000, 1);

    // Enable high-quality VSM shadows (Variance Shadow Maps)
    renderer3d.shadowMap.enabled = true;
    renderer3d.shadowMap.type = THREE.VSMShadowMap;  // VSM for smooth soft shadows
    renderer3d.domElement.id = 'gameCanvas3D';
    renderer3d.domElement.style.position = 'absolute';
    renderer3d.domElement.style.top = '0';
    renderer3d.domElement.style.left = '0';
    renderer3d.domElement.style.width = '100%';
    renderer3d.domElement.style.height = '100%';
    renderer3d.domElement.style.touchAction = 'none';
    renderer3d.domElement.tabIndex = 1;  // Make focusable

    // Hide the 2D canvas and add the 3D canvas
    const canvas2d = document.getElementById('gameCanvas');
    if (canvas2d) {
        canvas2d.style.display = 'none';
    }
    container.appendChild(renderer3d.domElement);

    // Add event listeners to track focus for input handling
    renderer3d.domElement.addEventListener('mousedown', function(e) {
        if (typeof lastDownTarget !== 'undefined') {
            lastDownTarget = renderer3d.domElement;
        }
    });
    renderer3d.domElement.addEventListener('touchstart', function(e) {
        if (typeof lastDownTarget !== 'undefined') {
            lastDownTarget = renderer3d.domElement;
        }
    });

    // Create the scene
    scene3d = new THREE.Scene();
    
    // Create a group to hold all level meshes (for efficient batch operations)
    levelGroup = new THREE.Group();
    scene3d.add(levelGroup);

    // Create the camera
    camera3d = new THREE.PerspectiveCamera(
        CAMERA_FOV,
        container.clientWidth / container.clientHeight,
        CAMERA_NEAR,
        CAMERA_FAR
    );
    updateCameraPosition();

    // === THREE-POINT LIGHTING SYSTEM ===

    // Ambient light - very low, just to prevent pure black shadows
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.15);
    scene3d.add(ambientLight);

    // KEY LIGHT - Main light, warm color, casts shadows
    // Positioned front-right, above the scene
    keyLight = new THREE.DirectionalLight(0xfffaf0, 1.0);  // Warm white
    keyLight.position.set(30, 50, 30);
    keyLight.castShadow = true;

    // VSM shadow settings for key light
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 1;
    keyLight.shadow.camera.far = 200;
    keyLight.shadow.camera.left = -50;
    keyLight.shadow.camera.right = 50;
    keyLight.shadow.camera.top = 50;
    keyLight.shadow.camera.bottom = -50;

    // VSM-specific: radius controls shadow softness (blur)
    keyLight.shadow.radius = 8;  // Soft shadow blur radius
    keyLight.shadow.blurSamples = 25;  // Quality of blur

    // VSM doesn't need traditional bias, but small values help
    keyLight.shadow.bias = 0.0001;

    scene3d.add(keyLight);
    scene3d.add(keyLight.target);

    // FILL LIGHT - Soft light, cool color, no shadows
    // Positioned front-left, lower than key light
    fillLight = new THREE.DirectionalLight(0xe0e8ff, 0.4);  // Cool blue-white
    fillLight.position.set(-30, 25, 20);
    fillLight.castShadow = false;  // Fill light doesn't cast shadows
    scene3d.add(fillLight);

    // BACK LIGHT (Rim Light) - Creates edge definition
    // Positioned behind and above the scene
    backLight = new THREE.DirectionalLight(0xfff0e0, 0.6);  // Warm accent
    backLight.position.set(0, 40, -40);
    backLight.castShadow = false;  // Back light doesn't cast shadows
    scene3d.add(backLight);

    // Create reusable cube geometry
    cubeGeometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);

    // Handle window resize
    window.addEventListener('resize', onWindowResize3D, false);

    console.log('3D Renderer initialized successfully!');
    return true;
}

/**
 * Handle window resize for 3D renderer
 */
function onWindowResize3D() {
    if (!renderer3d || !camera3d || !container3d) return;

    camera3d.aspect = container3d.clientWidth / container3d.clientHeight;
    camera3d.updateProjectionMatrix();
    renderer3d.setSize(container3d.clientWidth, container3d.clientHeight);
}

/**
 * Update camera position based on angles and distance
 */
function updateCameraPosition() {
    if (!camera3d || !scene3d) return;

    // Calculate camera position in spherical coordinates
    const x = cameraDistance * Math.sin(cameraAngleY) * Math.cos(cameraAngleX);
    const y = cameraDistance * Math.sin(cameraAngleX) + 10;
    const z = cameraDistance * Math.cos(cameraAngleY) * Math.cos(cameraAngleX);

    camera3d.position.set(x, y, z);
    camera3d.lookAt(0, 0, 0);
}

/**
 * Get or create a material for a given color
 */
function getMaterial(color) {
    if (!color || color === 'transparent' || color === '#00000000') {
        return null;
    }

    // Normalize color
    const normalizedColor = color.toLowerCase();

    if (!cubeMaterials[normalizedColor]) {
        // Parse the color
        const threeColor = new THREE.Color(normalizedColor);
        // Use MeshStandardMaterial for better lighting/shadow response
        cubeMaterials[normalizedColor] = new THREE.MeshStandardMaterial({
            color: threeColor,
            roughness: 0.7,
            metalness: 0.0
        });
    }

    return cubeMaterials[normalizedColor];
}

/**
 * Mark all cached meshes as not in use (called at start of redraw)
 */
function beginRedraw3D() {
    for (const key in meshCache) {
        meshCache[key].inUse = false;
    }
    animatedMeshes = [];
}

/**
 * Remove meshes that are no longer in use (called at end of redraw)
 */
function endRedraw3D() {
    for (const key in meshCache) {
        if (!meshCache[key].inUse) {
            const mesh = meshCache[key].mesh;
            levelGroup.remove(mesh);
            // Don't dispose geometry - it's shared
            delete meshCache[key];
        }
    }
}

/**
 * Clear all meshes from the scene (for level changes)
 */
function clearScene3D() {
    if (levelGroup) {
        // Clear all children at once
        while (levelGroup.children.length > 0) {
            levelGroup.remove(levelGroup.children[0]);
        }
    }
    meshCache = {};
    animatedMeshes = [];
}

/**
 * Snapshot the current level state before a move happens.
 * Call this before processInput to enable smooth animation.
 */
function snapshotLevelState() {
    if (!level || !level.objects) return;
    previousLevelState = {
        objects: new Int32Array(level.objects),
        width: level.width,
        height: level.height
    };
}

/**
 * Build a map of object positions from a level state.
 * Returns: { objectIndex: [posIndex1, posIndex2, ...], ... }
 */
function buildObjectPositionMap(objects, width, height) {
    const map = {};
    const n_tiles = width * height;
    
    for (let posIndex = 0; posIndex < n_tiles; posIndex++) {
        // Read the cell's object bitmask
        for (let s = 0; s < STRIDE_OBJ; s++) {
            const word = objects[posIndex * STRIDE_OBJ + s];
            if (word === 0) continue;
            
            for (let bit = 0; bit < 32; bit++) {
                if (word & (1 << bit)) {
                    const objectIndex = s * 32 + bit;
                    if (!map[objectIndex]) {
                        map[objectIndex] = [];
                    }
                    map[objectIndex].push(posIndex);
                }
            }
        }
    }
    return map;
}

/**
 * Detect movements by comparing previous and current level states.
 * Returns array of: { objectIndex, fromPosIndex, toPosIndex }
 */
function detectMovements() {
    if (!previousLevelState || !level || !level.objects) return [];
    
    const oldMap = buildObjectPositionMap(
        previousLevelState.objects, 
        previousLevelState.width, 
        previousLevelState.height
    );
    const newMap = buildObjectPositionMap(
        level.objects, 
        level.width, 
        level.height
    );
    
    const movements = [];
    
    // For each object type, find what moved
    for (const objectIndex in newMap) {
        const oldPositions = oldMap[objectIndex] || [];
        const newPositions = newMap[objectIndex];
        
        // First pass: mark all positions that exist in both old and new as "used"
        // These objects stayed in place and don't need animation
        const usedOld = new Set();
        const usedNew = new Set();
        
        for (const newPos of newPositions) {
            if (oldPositions.includes(newPos)) {
                // Object exists in same position - it didn't move
                usedOld.add(newPos);
                usedNew.add(newPos);
            }
        }
        
        // Second pass: match remaining positions by proximity
        for (const newPos of newPositions) {
            if (usedNew.has(newPos)) continue;  // Already matched (stayed in place)
            
            const newX = (newPos / level.height) | 0;
            const newY = newPos % level.height;
            
            let bestOldPos = null;
            let bestDist = Infinity;
            
            for (const oldPos of oldPositions) {
                if (usedOld.has(oldPos)) continue;
                
                const oldX = (oldPos / previousLevelState.height) | 0;
                const oldY = oldPos % previousLevelState.height;
                
                const dist = Math.abs(newX - oldX) + Math.abs(newY - oldY);
                if (dist < bestDist && dist > 0 && dist <= 2) {  // Only animate small moves
                    bestDist = dist;
                    bestOldPos = oldPos;
                }
            }
            
            if (bestOldPos !== null) {
                usedOld.add(bestOldPos);
                movements.push({
                    objectIndex: parseInt(objectIndex),
                    fromPosIndex: bestOldPos,
                    toPosIndex: newPos
                });
            }
        }
    }
    
    return movements;
}

/**
 * Animation loop for smooth movement transitions
 */
function animate3D() {
    if (!isAnimating || !renderer3d || !scene3d || !camera3d) {
        isAnimating = false;
        return;
    }
    
    const elapsed = performance.now() - animationStartTime;
    const t = Math.min(elapsed / animationDuration, 1);
    
    // Smooth easing function (ease-out cubic)
    const easeT = 1 - Math.pow(1 - t, 3);
    
    // Update all animated mesh positions
    for (const anim of animatedMeshes) {
        anim.mesh.position.x = anim.startX + (anim.endX - anim.startX) * easeT;
        anim.mesh.position.z = anim.startZ + (anim.endZ - anim.startZ) * easeT;
    }
    
    // Render the scene
    renderer3d.render(scene3d, camera3d);
    
    if (t < 1) {
        animationFrameId = requestAnimationFrame(animate3D);
    } else {
        isAnimating = false;
        animatedMeshes = [];
    }
}

/**
 * Create a 3D representation of a sprite at a given grid position
 * Uses mesh caching to avoid removing/re-adding meshes unnecessarily.
 * @param {number} spriteIndex - Index into spriteimages array
 * @param {number} gridX - X position in level grid (0-indexed from visible area)
 * @param {number} gridY - Y position in level grid (0-indexed from visible area)
 * @param {number} layer - Layer (Y height) for multiple objects
 * @param {number} visibleWidth - Width of visible area
 * @param {number} visibleHeight - Height of visible area
 * @param {object} animFrom - Optional {gridX, gridY} for animation start position
 */
function createSprite3D(spriteIndex, gridX, gridY, layer, visibleWidth, visibleHeight, animFrom) {
    if (!sprites || !sprites[spriteIndex]) return;

    const sprite = sprites[spriteIndex];
    const spriteData = sprite.dat;
    const colors = sprite.colors;

    if (!spriteData || !colors) return;

    const spriteHeight = spriteData.length;
    const spriteWidth = spriteData[0] ? spriteData[0].length : 0;

    // Calculate cell size (sprite dimensions + spacing)
    const cellSizeX = spriteWidth * CUBE_SIZE;
    const cellSizeZ = spriteHeight * CUBE_SIZE;

    // Center the level around origin
    const totalWidth = visibleWidth * cellSizeX;
    const totalHeight = visibleHeight * cellSizeZ;

    const baseX = gridX * cellSizeX - totalWidth / 2;
    const baseZ = gridY * cellSizeZ - totalHeight / 2;
    const baseY = layer * CUBE_SIZE;
    
    // Calculate animation start position if provided
    let startBaseX = baseX;
    let startBaseZ = baseZ;
    if (animFrom) {
        startBaseX = animFrom.gridX * cellSizeX - totalWidth / 2;
        startBaseZ = animFrom.gridY * cellSizeZ - totalHeight / 2;
    }

    // Create cubes for each pixel in the sprite
    for (let py = 0; py < spriteHeight; py++) {
        for (let px = 0; px < spriteWidth; px++) {
            const colorIndex = spriteData[py][px];

            if (colorIndex < 0) continue;  // Skip transparent pixels

            const color = colors[colorIndex];
            const material = getMaterial(color);

            if (!material) continue;  // Skip if no valid material

            // Generate cache key for this cube
            const cacheKey = `${spriteIndex}_${gridX}_${gridY}_${layer}_${px}_${py}`;
            
            // Final position
            const endX = baseX + px * CUBE_SIZE;
            const endZ = baseZ + py * CUBE_SIZE;
            
            let cube;
            let cached = meshCache[cacheKey];
            
            if (cached) {
                // Reuse existing mesh
                cube = cached.mesh;
                cached.inUse = true;
                
                // Update material if it changed
                if (cube.material !== material) {
                    cube.material = material;
                }
            } else {
                // Create new mesh
                cube = new THREE.Mesh(cubeGeometry, material);
                cube.castShadow = true;
                cube.receiveShadow = true;
                levelGroup.add(cube);
                meshCache[cacheKey] = { mesh: cube, inUse: true };
            }
            
            // If animating, set up animation
            if (animFrom) {
                const startX = startBaseX + px * CUBE_SIZE;
                const startZ = startBaseZ + py * CUBE_SIZE;
                
                cube.position.set(startX, baseY, startZ);
                
                // Track for animation
                animatedMeshes.push({
                    mesh: cube,
                    startX: startX,
                    startZ: startZ,
                    endX: endX,
                    endZ: endZ
                });
            } else {
                cube.position.set(endX, baseY, endZ);
            }
        }
    }
}

/**
 * Main 3D redraw function - replaces the 2D redraw() when in 3D mode
 */
function redraw3D() {
    if (!use3DRenderer || !renderer3d || !scene3d || !camera3d) {
        return false;  // Fall back to 2D
    }

    // Handle text mode - fall back to 2D for menus
    if (textMode) {
        // Show 2D canvas, hide 3D canvas for text screens
        const canvas2d = document.getElementById('gameCanvas');
        const canvas3d = document.getElementById('gameCanvas3D');
        if (canvas2d) canvas2d.style.display = 'block';
        if (canvas3d) canvas3d.style.display = 'none';
        return false;  // Let 2D handle text screens
    } else {
        // Show 3D canvas, hide 2D canvas for gameplay
        const canvas2d = document.getElementById('gameCanvas');
        const canvas3d = document.getElementById('gameCanvas3D');
        if (canvas2d) canvas2d.style.display = 'none';
        if (canvas3d) canvas3d.style.display = 'block';
    }

    // Mark all cached meshes as not in use; we'll mark them as used when we process them
    beginRedraw3D();

    // Set background color
    if (state && state.bgcolor) {
        renderer3d.setClearColor(new THREE.Color(state.bgcolor), 1);
    }

    // Get current level data
    const curlevel = level;
    if (!curlevel || !curlevel.width || !curlevel.height) {
        renderer3d.render(scene3d, camera3d);
        return true;
    }
    
    // Detect level changes and clear cache when level changes
    const currentLevelId = typeof curlevelTarget !== 'undefined' ? curlevelTarget : null;
    if (currentLevelId !== lastLevelId) {
        clearScene3D();
        lastLevelId = currentLevelId;
    }

    // Calculate visible area (handle flickscreen/zoomscreen)
    let mini = 0;
    let maxi = screenwidth;
    let minj = 0;
    let maxj = screenheight;

    if (flickscreen) {
        var playerPositions = getPlayerPositions();
        if (playerPositions.length > 0) {
            var playerPosition = playerPositions[0];
            var px = (playerPosition / curlevel.height) | 0;
            var py = (playerPosition % curlevel.height) | 0;
            var screenx = (px / screenwidth) | 0;
            var screeny = (py / screenheight) | 0;
            mini = screenx * screenwidth;
            minj = screeny * screenheight;
            maxi = Math.min(mini + screenwidth, curlevel.width);
            maxj = Math.min(minj + screenheight, curlevel.height);
        }
    } else if (zoomscreen) {
        var playerPositions = getPlayerPositions();
        if (playerPositions.length > 0) {
            var playerPosition = playerPositions[0];
            var px = (playerPosition / curlevel.height) | 0;
            var py = (playerPosition % curlevel.height) | 0;
            mini = Math.max(Math.min(px - ((screenwidth / 2) | 0), curlevel.width - screenwidth), 0);
            minj = Math.max(Math.min(py - ((screenheight / 2) | 0), curlevel.height - screenheight), 0);
            maxi = Math.min(mini + screenwidth, curlevel.width);
            maxj = Math.min(minj + screenheight, curlevel.height);
        }
    }

    // Update camera to center on visible area
    const visibleWidth = maxi - mini;
    const visibleHeight = maxj - minj;
    cameraDistance = Math.max(visibleWidth, visibleHeight) * CAMERA_DISTANCE;
    updateCameraPosition();

    // Update shadow camera to cover the level area
    if (keyLight) {
        const shadowSize = Math.max(visibleWidth, visibleHeight) * 6;
        keyLight.shadow.camera.left = -shadowSize;
        keyLight.shadow.camera.right = shadowSize;
        keyLight.shadow.camera.top = shadowSize;
        keyLight.shadow.camera.bottom = -shadowSize;
        keyLight.shadow.camera.updateProjectionMatrix();

        // Position key light relative to level center (front-right-above)
        keyLight.position.set(shadowSize * 0.6, shadowSize * 1.2, shadowSize * 0.6);
        keyLight.target.position.set(0, 0, 0);

        // Update fill light position (front-left)
        if (fillLight) {
            fillLight.position.set(-shadowSize * 0.6, shadowSize * 0.5, shadowSize * 0.4);
        }

        // Update back light position (behind-above)
        if (backLight) {
            backLight.position.set(0, shadowSize * 0.8, -shadowSize * 0.8);
        }
    }

    // Create ground plane to receive shadows
    if (!groundPlane) {
        const groundGeometry = new THREE.PlaneGeometry(200, 200);
        // Use MeshStandardMaterial with subtle color for visible ground with shadows
        const groundMaterial = new THREE.MeshStandardMaterial({
            color: 0x333333,
            roughness: 0.9,
            metalness: 0.0,
            transparent: true,
            opacity: 0.6
        });
        groundPlane = new THREE.Mesh(groundGeometry, groundMaterial);
        groundPlane.rotation.x = -Math.PI / 2;  // Lay flat
        groundPlane.position.y = -0.5;  // Just below the cubes
        groundPlane.receiveShadow = true;
        scene3d.add(groundPlane);
    }

    // Detect movements for animation
    const movements = detectMovements();
    
    // Build a map of movements: toPosIndex -> {objectIndex, fromX, fromY}
    const movementMap = {};
    for (const m of movements) {
        const fromX = (m.fromPosIndex / previousLevelState.height) | 0;
        const fromY = m.fromPosIndex % previousLevelState.height;
        const key = `${m.toPosIndex}_${m.objectIndex}`;
        movementMap[key] = { fromX, fromY };
    }

    // Render all objects in the visible area
    let layerCounter = {};  // Track layers per cell

    for (let i = mini; i < maxi; i++) {
        for (let j = minj; j < maxj; j++) {
            const posIndex = j + i * curlevel.height;
            const posMask = curlevel.getCellInto(posIndex, _o12);

            const cellKey = `${i},${j}`;
            layerCounter[cellKey] = layerCounter[cellKey] || 0;

            for (let k = 0; k < state.objectCount; k++) {
                if (posMask.get(k) != 0) {
                    // Check if this object moved here
                    const movementKey = `${posIndex}_${k}`;
                    let animFrom = null;
                    
                    if (movementMap[movementKey]) {
                        const m = movementMap[movementKey];
                        // Convert from absolute coords to visible-area relative coords
                        animFrom = {
                            gridX: m.fromX - mini,
                            gridY: m.fromY - minj
                        };
                    }
                    
                    createSprite3D(k, i - mini, j - minj, layerCounter[cellKey], visibleWidth, visibleHeight, animFrom);
                    layerCounter[cellKey]++;
                }
            }
        }
    }
    
    // Clear the previous state snapshot
    previousLevelState = null;

    // Remove meshes that are no longer needed
    endRedraw3D();

    // Start animation if we have movements
    if (animatedMeshes.length > 0) {
        isAnimating = true;
        animationStartTime = performance.now();
        animate3D();
    } else {
        // No animation, just render once
        renderer3d.render(scene3d, camera3d);
    }
    
    return true;
}

/**
 * Toggle between 2D and 3D rendering
 */
function toggle3DRenderer() {
    use3DRenderer = !use3DRenderer;

    const canvas2d = document.getElementById('gameCanvas');
    const canvas3d = document.getElementById('gameCanvas3D');

    if (use3DRenderer) {
        if (!renderer3d) {
            if (!init3DRenderer()) {
                // Init failed, stay in 2D mode
                use3DRenderer = false;
                return;
            }
        }
        if (canvas2d) canvas2d.style.display = 'none';
        if (canvas3d) canvas3d.style.display = 'block';
    } else {
        if (canvas2d) canvas2d.style.display = 'block';
        if (canvas3d) canvas3d.style.display = 'none';
    }

    // Trigger redraw
    if (typeof canvasResize === 'function') {
        canvasResize();
    } else if (typeof redraw === 'function') {
        redraw();
    }

    console.log('Rendering mode: ' + (use3DRenderer ? '3D' : '2D'));
}

// Keyboard shortcuts for camera control
document.addEventListener('keydown', function(e) {
    // Toggle 3D mode with Ctrl+3 or Cmd+3 (works even without renderer initialized)
    if (e.key === '3' && (e.ctrlKey || e.metaKey)) {
        toggle3DRenderer();
        e.preventDefault();
        return;
    }

    if (!use3DRenderer || !renderer3d) return;

    // Only handle camera controls when not in text mode
    if (typeof textMode !== 'undefined' && textMode) return;
});

// Auto-initialize 3D renderer when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() {
        setTimeout(init3DRenderer, 100);
    });
} else {
    setTimeout(init3DRenderer, 100);
}
