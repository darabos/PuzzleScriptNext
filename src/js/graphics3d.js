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
let use3DRenderer = true; // Toggle between 2D and 3D rendering
let groundPlane = null;  // Ground plane to receive shadows

// Sprite geometry caching - merged geometry per sprite type
let spriteGeometries = {};  // spriteIndex -> THREE.BufferGeometry (merged cubes with vertex colors)
let spriteMaterial = null;  // Shared material using vertex colors
let clayNormalMap = null;   // Normal map texture for clay look

// Instanced mesh system - one InstancedMesh per sprite type
let instancedMeshes = {};   // spriteIndex -> THREE.InstancedMesh
let instanceCounts = {};    // spriteIndex -> current instance count
let levelGroup = null;      // THREE.Group to hold all level meshes
let lastLevelId = null;     // Track level identity for cache invalidation
let lastSpritesRef = null;  // Track sprites array to detect recompilation

// Three-point lighting system
let keyLight = null;     // Main shadow-casting light (warm)
let fillLight = null;    // Soft fill light (cool)

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
    keyLight = new THREE.SpotLight(0xffeedd, 1);  // Warm white, higher intensity for spot
    keyLight.angle = Math.PI / 4;  // Cone angle (45 degrees)
    keyLight.penumbra = 0.5;  // Soft edge falloff
    keyLight.decay = 1.5;  // Light decay with distance
    keyLight.castShadow = true;

    // Shadow settings for spot light
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 10;
    keyLight.shadow.camera.far = 200;
    keyLight.shadow.camera.fov = 50;

    // VSM-specific: radius controls shadow softness (blur)
    keyLight.shadow.radius = 8;  // Soft shadow blur radius
    keyLight.shadow.blurSamples = 25;  // Quality of blur

    // Shadow bias
    keyLight.shadow.bias = 0.0001;

    scene3d.add(keyLight);
    scene3d.add(keyLight.target);

    // FILL LIGHT - Soft light, cool color, no shadows
    // Positioned front-left, lower than key light
    fillLight = new THREE.DirectionalLight(0xddeeff, 0.5);  // Cool blue-white
    fillLight.castShadow = false;  // Fill light doesn't cast shadows
    scene3d.add(fillLight);

    // Create reusable cube geometry
    cubeGeometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);

    // Load clay normal map texture (optional - works without it for standalone export)
    const textureLoader = new THREE.TextureLoader();
    const NORMAL_SCALE = 0.5;  // Adjust normal map strength for subtle effect
    clayNormalMap = textureLoader.load('images/clay_normal.jpg',
        function(texture) {
            texture.wrapS = THREE.RepeatWrapping;
            texture.wrapT = THREE.RepeatWrapping;
            // Update material once texture is loaded
            if (spriteMaterial) {
                spriteMaterial.normalMap = texture;
                spriteMaterial.normalScale = new THREE.Vector2(NORMAL_SCALE, NORMAL_SCALE);
                spriteMaterial.needsUpdate = true;
            }
        },
        undefined,  // onProgress
        function(error) {
            // Normal map not available (e.g., standalone export) - continue without it
            console.log('Normal map not available, using flat shading');
            clayNormalMap = null;
        }
    );

    // Create shared material that uses vertex colors (normal map added when loaded)
    spriteMaterial = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: 0.7,
        metalness: 0.0
    });

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
 * Check if a pixel in the sprite is filled (non-transparent)
 */
function isPixelFilled(spriteData, colors, px, py, width, height) {
    if (px < 0 || px >= width || py < 0 || py >= height) return false;
    const colorIndex = spriteData[py][px];
    if (colorIndex < 0) return false;
    const color = colors[colorIndex];
    return color && color !== 'transparent' && color !== '#00000000';
}

/**
 * Get or create a merged geometry for a sprite (all cubes combined with vertex colors)
 * Implements rounded edges based on neighbor occupancy for claymation look
 */
function getOrCreateSpriteGeometry(spriteIndex) {
    if (spriteGeometries[spriteIndex]) {
        return spriteGeometries[spriteIndex];
    }

    if (!sprites || !sprites[spriteIndex]) return null;

    const sprite = sprites[spriteIndex];
    const spriteData = sprite.dat;
    const colors = sprite.colors;

    if (!spriteData || !colors) return null;

    const spriteHeight = spriteData.length;
    const spriteWidth = spriteData[0] ? spriteData[0].length : 0;

    // Count non-transparent pixels to pre-allocate arrays
    let cubeCount = 0;
    for (let py = 0; py < spriteHeight; py++) {
        for (let px = 0; px < spriteWidth; px++) {
            if (isPixelFilled(spriteData, colors, px, py, spriteWidth, spriteHeight)) {
                cubeCount++;
            }
        }
    }

    if (cubeCount === 0) return null;

    // Create merged geometry
    const positions = [];
    const normals = [];
    const vertexColors = [];
    const uvs = [];
    const indices = [];

    const halfSize = CUBE_SIZE / 2;
    const bevel = CUBE_SIZE * 0.25;  // Bevel size for rounding
    const uvScale = 0.2;  // Scale factor for UV tiling

    // Random rotation angle for this sprite's normal map (to reduce tiling repetition)
    const uvRotation = Math.random() * Math.PI * 2;
    const uvCos = Math.cos(uvRotation);
    const uvSin = Math.sin(uvRotation);

    let vertexOffset = 0;

    // Helper to add a vertex with UV based on position (rotated by random angle)
    function addVertex(x, y, z, nx, ny, nz, color) {
        positions.push(x, y, z);
        normals.push(nx, ny, nz);
        vertexColors.push(color.r, color.g, color.b);
        // UV coordinates: use x+y for u, z+y for v (so vertical faces get texture too)
        // Apply random rotation to reduce visible tiling
        const u = (x + y) * uvScale;
        const v = (z + y) * uvScale;
        uvs.push(u * uvCos - v * uvSin, u * uvSin + v * uvCos);
    }

    // Helper to add a triangle
    function addTriangle(v0, v1, v2) {
        indices.push(vertexOffset + v0, vertexOffset + v1, vertexOffset + v2);
    }

    // Helper to add a quad (two triangles)
    function addQuad(v0, v1, v2, v3) {
        indices.push(vertexOffset + v0, vertexOffset + v1, vertexOffset + v2);
        indices.push(vertexOffset + v0, vertexOffset + v2, vertexOffset + v3);
    }

    for (let py = 0; py < spriteHeight; py++) {
        for (let px = 0; px < spriteWidth; px++) {
            if (!isPixelFilled(spriteData, colors, px, py, spriteWidth, spriteHeight)) continue;

            const colorIndex = spriteData[py][px];
            const color = colors[colorIndex];
            const threeColor = new THREE.Color(color.toLowerCase());

            // Offset for this cube within the sprite
            const offsetX = px * CUBE_SIZE;
            const offsetZ = py * CUBE_SIZE;

            // Check neighbors (in sprite coordinates: x=right, z=down in 3D)
            const hasLeft = isPixelFilled(spriteData, colors, px - 1, py, spriteWidth, spriteHeight);
            const hasRight = isPixelFilled(spriteData, colors, px + 1, py, spriteWidth, spriteHeight);
            const hasFront = isPixelFilled(spriteData, colors, px, py + 1, spriteWidth, spriteHeight);  // +Z
            const hasBack = isPixelFilled(spriteData, colors, px, py - 1, spriteWidth, spriteHeight);   // -Z

            // Diagonal neighbors for corners
            const hasBackLeft = isPixelFilled(spriteData, colors, px - 1, py - 1, spriteWidth, spriteHeight);
            const hasBackRight = isPixelFilled(spriteData, colors, px + 1, py - 1, spriteWidth, spriteHeight);
            const hasFrontLeft = isPixelFilled(spriteData, colors, px - 1, py + 1, spriteWidth, spriteHeight);
            const hasFrontRight = isPixelFilled(spriteData, colors, px + 1, py + 1, spriteWidth, spriteHeight);

            // Determine corner rounding based on the rules
            // A corner is exposed if it's at the intersection of two exposed edges
            // or if the diagonal is empty and both adjacent edges are present
            const cornerBackLeft = (!hasLeft && !hasBack) || (!hasBackLeft && hasLeft && hasBack);
            const cornerBackRight = (!hasRight && !hasBack) || (!hasBackRight && hasRight && hasBack);
            const cornerFrontLeft = (!hasLeft && !hasFront) || (!hasFrontLeft && hasLeft && hasFront);
            const cornerFrontRight = (!hasRight && !hasFront) || (!hasFrontRight && hasRight && hasFront);

            // Edge bevels (only on exposed edges)
            const bevelLeft = !hasLeft;
            const bevelRight = !hasRight;
            const bevelFront = !hasFront;
            const bevelBack = !hasBack;

            // Build the voxel geometry with bevels
            // We'll build the voxel with beveled edges:
            // - Inner top face (inset, at full height)
            // - Top bevel strip (angled faces from inner edge down to outer edge)
            // - Vertical sides (outer perimeter)
            // - Bottom bevel strip (angled faces from outer edge up to inner edge)
            // - Inner bottom face (inset, at full depth)

            // Y coordinates for the geometry
            const innerTopY = halfSize;              // Top face stays at full height
            const outerTopY = halfSize - bevel;      // Outer edge is lowered by bevel
            const outerBotY = -halfSize + bevel;     // Outer bottom edge is raised by bevel
            const innerBotY = -halfSize;             // Bottom face at full depth

            // Define corner positions
            // Back-left corner (-X, -Z)
            let blX = -halfSize + offsetX;
            let blZ = -halfSize + offsetZ;
            let blBevelX = bevelLeft ? bevel : 0;
            let blBevelZ = bevelBack ? bevel : 0;

            // Back-right corner (+X, -Z)
            let brX = halfSize + offsetX;
            let brZ = -halfSize + offsetZ;
            let brBevelX = bevelRight ? -bevel : 0;
            let brBevelZ = bevelBack ? bevel : 0;

            // Front-right corner (+X, +Z)
            let frX = halfSize + offsetX;
            let frZ = halfSize + offsetZ;
            let frBevelX = bevelRight ? -bevel : 0;
            let frBevelZ = bevelFront ? -bevel : 0;

            // Front-left corner (-X, +Z)
            let flX = -halfSize + offsetX;
            let flZ = halfSize + offsetZ;
            let flBevelX = bevelLeft ? bevel : 0;
            let flBevelZ = bevelFront ? -bevel : 0;

            // ===== BUILD INNER PERIMETER (top face outline, inset by bevel) =====
            let innerVerts = [];

            // Back-left corner
            if (cornerBackLeft && (bevelLeft || bevelBack)) {
                if (bevelLeft) innerVerts.push([blX + blBevelX, blZ + blBevelZ + bevel]);
                if (bevelBack) innerVerts.push([blX + blBevelX + bevel, blZ + blBevelZ]);
            } else {
                innerVerts.push([blX + blBevelX, blZ + blBevelZ]);
            }

            // Back-right corner
            if (cornerBackRight && (bevelRight || bevelBack)) {
                if (bevelBack) innerVerts.push([brX + brBevelX - bevel, brZ + brBevelZ]);
                if (bevelRight) innerVerts.push([brX + brBevelX, brZ + brBevelZ + bevel]);
            } else {
                innerVerts.push([brX + brBevelX, brZ + brBevelZ]);
            }

            // Front-right corner
            if (cornerFrontRight && (bevelRight || bevelFront)) {
                if (bevelRight) innerVerts.push([frX + frBevelX, frZ + frBevelZ - bevel]);
                if (bevelFront) innerVerts.push([frX + frBevelX - bevel, frZ + frBevelZ]);
            } else {
                innerVerts.push([frX + frBevelX, frZ + frBevelZ]);
            }

            // Front-left corner
            if (cornerFrontLeft && (bevelLeft || bevelFront)) {
                if (bevelFront) innerVerts.push([flX + flBevelX + bevel, flZ + flBevelZ]);
                if (bevelLeft) innerVerts.push([flX + flBevelX, flZ + flBevelZ - bevel]);
            } else {
                innerVerts.push([flX + flBevelX, flZ + flBevelZ]);
            }

            // ===== BUILD OUTER PERIMETER (original corners, no inset) =====
            let outerVerts = [];

            // Back-left corner
            if (cornerBackLeft && (bevelLeft || bevelBack)) {
                if (bevelLeft) outerVerts.push([blX, blZ + bevel]);
                if (bevelBack) outerVerts.push([blX + bevel, blZ]);
            } else {
                outerVerts.push([blX, blZ]);
            }

            // Back-right corner
            if (cornerBackRight && (bevelRight || bevelBack)) {
                if (bevelBack) outerVerts.push([brX - bevel, brZ]);
                if (bevelRight) outerVerts.push([brX, brZ + bevel]);
            } else {
                outerVerts.push([brX, brZ]);
            }

            // Front-right corner
            if (cornerFrontRight && (bevelRight || bevelFront)) {
                if (bevelRight) outerVerts.push([frX, frZ - bevel]);
                if (bevelFront) outerVerts.push([frX - bevel, frZ]);
            } else {
                outerVerts.push([frX, frZ]);
            }

            // Front-left corner
            if (cornerFrontLeft && (bevelLeft || bevelFront)) {
                if (bevelFront) outerVerts.push([flX + bevel, flZ]);
                if (bevelLeft) outerVerts.push([flX, flZ - bevel]);
            } else {
                outerVerts.push([flX, flZ]);
            }

            // ===== INNER TOP FACE =====
            const topStartIdx = positions.length / 3;
            for (const v of innerVerts) {
                addVertex(v[0], innerTopY, v[1], 0, 1, 0, threeColor);
            }
            for (let i = 1; i < innerVerts.length - 1; i++) {
                indices.push(topStartIdx, topStartIdx + i + 1, topStartIdx + i);
            }

            // ===== TOP BEVEL STRIP =====
            // Connect inner perimeter (at innerTopY) to outer perimeter (at outerTopY)
            const n = innerVerts.length;
            for (let i = 0; i < n; i++) {
                const i2 = (i + 1) % n;
                const inner1 = innerVerts[i];
                const inner2 = innerVerts[i2];
                const outer1 = outerVerts[i];
                const outer2 = outerVerts[i2];

                // Calculate normal for this bevel face (pointing outward and upward)
                const dx = outer2[0] - outer1[0];
                const dz = outer2[1] - outer1[1];
                const len = Math.sqrt(dx * dx + dz * dz);
                const sideNx = dz / len;
                const sideNz = -dx / len;
                // Bevel normal is tilted 45 degrees up
                const bevelLen = Math.sqrt(2);
                const nx = sideNx / bevelLen;
                const ny = 1 / bevelLen;
                const nz = sideNz / bevelLen;

                const bevelStartIdx = positions.length / 3;
                addVertex(inner1[0], innerTopY, inner1[1], nx, ny, nz, threeColor);
                addVertex(inner2[0], innerTopY, inner2[1], nx, ny, nz, threeColor);
                addVertex(outer2[0], outerTopY, outer2[1], nx, ny, nz, threeColor);
                addVertex(outer1[0], outerTopY, outer1[1], nx, ny, nz, threeColor);
                indices.push(bevelStartIdx, bevelStartIdx + 1, bevelStartIdx + 2);
                indices.push(bevelStartIdx, bevelStartIdx + 2, bevelStartIdx + 3);
            }

            // ===== VERTICAL SIDES =====
            // Connect outer perimeter at outerTopY to outer perimeter at outerBotY
            for (let i = 0; i < n; i++) {
                const i2 = (i + 1) % n;
                const t1 = outerVerts[i];
                const t2 = outerVerts[i2];

                const dx = t2[0] - t1[0];
                const dz = t2[1] - t1[1];
                const len = Math.sqrt(dx * dx + dz * dz);
                const nx = dz / len;
                const nz = -dx / len;

                const sideStartIdx = positions.length / 3;
                addVertex(t1[0], outerTopY, t1[1], nx, 0, nz, threeColor);
                addVertex(t2[0], outerTopY, t2[1], nx, 0, nz, threeColor);
                addVertex(t2[0], outerBotY, t2[1], nx, 0, nz, threeColor);
                addVertex(t1[0], outerBotY, t1[1], nx, 0, nz, threeColor);
                indices.push(sideStartIdx, sideStartIdx + 1, sideStartIdx + 2);
                indices.push(sideStartIdx, sideStartIdx + 2, sideStartIdx + 3);
            }

            // ===== BOTTOM BEVEL STRIP =====
            // Connect outer perimeter (at outerBotY) to inner perimeter (at innerBotY)
            for (let i = 0; i < n; i++) {
                const i2 = (i + 1) % n;
                const outer1 = outerVerts[i];
                const outer2 = outerVerts[i2];
                const inner1 = innerVerts[i];
                const inner2 = innerVerts[i2];

                const dx = outer2[0] - outer1[0];
                const dz = outer2[1] - outer1[1];
                const len = Math.sqrt(dx * dx + dz * dz);
                const sideNx = dz / len;
                const sideNz = -dx / len;
                // Bevel normal is tilted 45 degrees down
                const bevelLen = Math.sqrt(2);
                const nx = sideNx / bevelLen;
                const ny = -1 / bevelLen;
                const nz = sideNz / bevelLen;

                const bevelStartIdx = positions.length / 3;
                addVertex(outer1[0], outerBotY, outer1[1], nx, ny, nz, threeColor);
                addVertex(outer2[0], outerBotY, outer2[1], nx, ny, nz, threeColor);
                addVertex(inner2[0], innerBotY, inner2[1], nx, ny, nz, threeColor);
                addVertex(inner1[0], innerBotY, inner1[1], nx, ny, nz, threeColor);
                indices.push(bevelStartIdx, bevelStartIdx + 1, bevelStartIdx + 2);
                indices.push(bevelStartIdx, bevelStartIdx + 2, bevelStartIdx + 3);
            }

            // ===== INNER BOTTOM FACE =====
            const botStartIdx = positions.length / 3;
            for (const v of innerVerts) {
                addVertex(v[0], innerBotY, v[1], 0, -1, 0, threeColor);
            }
            for (let i = 1; i < innerVerts.length - 1; i++) {
                indices.push(botStartIdx, botStartIdx + i, botStartIdx + i + 1);
            }
        }
    }

    // Create BufferGeometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(vertexColors, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setIndex(indices);

    spriteGeometries[spriteIndex] = geometry;
    return geometry;
}

/**
 * Reset instance counts at start of redraw
 */
function beginRedraw3D() {
    for (const key in instanceCounts) {
        instanceCounts[key] = 0;
    }
    animatedMeshes = [];
}

/**
 * Finalize instanced meshes after redraw
 */
function endRedraw3D() {
    for (const spriteIndex in instancedMeshes) {
        const mesh = instancedMeshes[spriteIndex];
        const count = instanceCounts[spriteIndex] || 0;
        mesh.count = count;
        mesh.instanceMatrix.needsUpdate = true;
    }
}

/**
 * Clear all meshes from the scene (for level changes)
 */
function clearScene3D() {
    if (levelGroup) {
        while (levelGroup.children.length > 0) {
            levelGroup.remove(levelGroup.children[0]);
        }
    }
    instancedMeshes = {};
    instanceCounts = {};
    animatedMeshes = [];
    // Clear sprite geometries when switching games (sprites may have changed)
    spriteGeometries = {};
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

    // Temporary matrix for instance updates
    const matrix = new THREE.Matrix4();

    // Update all animated instance positions
    for (const anim of animatedMeshes) {
        const x = anim.startX + (anim.endX - anim.startX) * easeT;
        const z = anim.startZ + (anim.endZ - anim.startZ) * easeT;
        matrix.setPosition(x, anim.y, z);
        anim.mesh.setMatrixAt(anim.instanceIndex, matrix);
        anim.mesh.instanceMatrix.needsUpdate = true;
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
 * Add a sprite instance at the given grid position.
 * Uses instanced rendering for performance.
 * @param {number} spriteIndex - Index into sprites array
 * @param {number} gridX - X position in level grid (0-indexed from visible area)
 * @param {number} gridY - Y position in level grid (0-indexed from visible area)
 * @param {number} layer - Layer (Y height) for multiple objects
 * @param {number} visibleWidth - Width of visible area
 * @param {number} visibleHeight - Height of visible area
 * @param {object} animFrom - Optional {gridX, gridY} for animation start position
 */
function createSprite3D(spriteIndex, gridX, gridY, layer, visibleWidth, visibleHeight, animFrom) {
    const geometry = getOrCreateSpriteGeometry(spriteIndex);
    if (!geometry) return;

    const sprite = sprites[spriteIndex];
    const spriteData = sprite.dat;
    const spriteHeight = spriteData.length;
    const spriteWidth = spriteData[0] ? spriteData[0].length : 0;

    // Calculate cell size
    const cellSizeX = spriteWidth * CUBE_SIZE;
    const cellSizeZ = spriteHeight * CUBE_SIZE;

    // Center the level around origin
    const totalWidth = visibleWidth * cellSizeX;
    const totalHeight = visibleHeight * cellSizeZ;

    const baseX = gridX * cellSizeX - totalWidth / 2;
    const baseZ = gridY * cellSizeZ - totalHeight / 2;
    const baseY = layer * CUBE_SIZE;

    // Get or create the InstancedMesh for this sprite
    let mesh = instancedMeshes[spriteIndex];
    if (!mesh) {
        // Create new InstancedMesh with generous max count
        const maxInstances = 1000;
        mesh = new THREE.InstancedMesh(geometry, spriteMaterial, maxInstances);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.count = 0;
        instancedMeshes[spriteIndex] = mesh;
        instanceCounts[spriteIndex] = 0;
        levelGroup.add(mesh);
    }

    // Get next instance index
    const instanceIndex = instanceCounts[spriteIndex];
    instanceCounts[spriteIndex]++;

    // Ensure we don't exceed max instances
    if (instanceIndex >= mesh.instanceMatrix.count) {
        console.warn('Max instances exceeded for sprite', spriteIndex);
        return;
    }

    // Create transformation matrix for this instance
    const matrix = new THREE.Matrix4();

    if (animFrom) {
        // Start at animation origin
        const startBaseX = animFrom.gridX * cellSizeX - totalWidth / 2;
        const startBaseZ = animFrom.gridY * cellSizeZ - totalHeight / 2;
        matrix.setPosition(startBaseX, baseY, startBaseZ);

        // Track for animation
        animatedMeshes.push({
            mesh: mesh,
            instanceIndex: instanceIndex,
            startX: startBaseX,
            startZ: startBaseZ,
            endX: baseX,
            endZ: baseZ,
            y: baseY
        });
    } else {
        matrix.setPosition(baseX, baseY, baseZ);
    }

    mesh.setMatrixAt(instanceIndex, matrix);
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

    // Detect recompilation (sprites array reference changes)
    if (typeof sprites !== 'undefined' && sprites !== lastSpritesRef) {
        clearScene3D();
        lastSpritesRef = sprites;
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
        const shadowSize = Math.max(visibleWidth, visibleHeight) * 3;

        // SpotLight uses perspective shadow camera - update far plane and distance
        keyLight.shadow.camera.far = shadowSize * 6;
        keyLight.shadow.camera.updateProjectionMatrix();

        // Position key light relative to level center (front-right-above)
        keyLight.position.set(shadowSize * 0.8, shadowSize * 0.6, shadowSize * 0.6);
        keyLight.target.position.set(0, 0, 0);

        // Update fill light position (front-left)
        if (fillLight) {
            fillLight.position.set(-shadowSize * 0.6, shadowSize * 0.5, shadowSize * 0.4);
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
                if (posMask.get(k) != 0 && getOrCreateSpriteGeometry(k)) {
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
