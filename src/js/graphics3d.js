/**
 * PuzzleScript 3D Renderer using Three.js
 *
 * This module replaces the traditional 2D canvas rendering with a 3D WebGL renderer.
 * Each pixel in the original sprites becomes a cube in 3D space.
 */

import * as THREE from 'three';

// Three.js globals
let renderer3d = null;
let scene3d = null;
let camera3d = null;
let container3d = null;  // The DOM container element
let groundPlane = null;  // Ground plane to receive shadows

// Sprite geometry caching - merged geometry per sprite type
let spriteGeometries = {};  // spriteIndex -> THREE.BufferGeometry (merged cubes with vertex colors)
let spriteTransmission = {};    // spriteIndex -> minimum alpha value (1.0 = fully opaque)
let spriteGlassMaterials = {};  // spriteIndex -> MeshPhysicalMaterial (per-sprite glass with custom transmission)
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
let isAnimating3D = false;        // Whether an animation is in progress
let animatedMeshes = [];        // Meshes that are being animated with their start/end positions
let animationFrameId = null;    // requestAnimationFrame ID

// Camera settings
const CAMERA_FOV = 40;
const CAMERA_NEAR = 0.1;
const CAMERA_FAR = 1000;
const CUBE_SIZE = 1;
const SPRITE_HEIGHT = 0.2;  // Sprite height as fraction of grid cell size.
const CAMERA_DISTANCE = 1.5;

// Camera position and rotation
let cameraDistance = CAMERA_DISTANCE;
let cameraAngleX = 1.2;
let cameraAngleY = 0.0;

/**
 * Add per-instance UV rotation to a material using onBeforeCompile.
 * This allows each instance of an InstancedMesh to have its own UV rotation,
 * breaking up visible tiling patterns in textures/normal maps.
 */
function addInstancedUvRotation(material) {
    material.onBeforeCompile = (shader) => {
        // Add the instance attribute declaration to vertex shader
        shader.vertexShader = shader.vertexShader.replace(
            '#include <common>',
            `#include <common>
            attribute float instanceUvRotation;
            varying float vUvRotation;`
        );
        // Pass the rotation to fragment shader
        shader.vertexShader = shader.vertexShader.replace(
            '#include <uv_vertex>',
            `#include <uv_vertex>
            vUvRotation = instanceUvRotation;`
        );
        // Declare the varying in fragment shader
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <common>',
            `#include <common>
            varying float vUvRotation;`
        );
        // Rotate UVs before normal map lookup
        shader.fragmentShader = shader.fragmentShader.replace(
            '#include <normal_fragment_maps>',
            `// Rotate UVs for normal map sampling
            #ifdef USE_NORMALMAP
            vec2 rotatedUv = vNormalMapUv;
            float uvCos = cos(vUvRotation);
            float uvSin = sin(vUvRotation);
            rotatedUv = vec2(
                rotatedUv.x * uvCos - rotatedUv.y * uvSin,
                rotatedUv.x * uvSin + rotatedUv.y * uvCos
            );
            vec3 mapN = texture2D( normalMap, rotatedUv ).xyz * 2.0 - 1.0;
            mapN.xy *= normalScale;
            normal = normalize( tbn * mapN );
            #endif`
        );
    };
}

/**
 * Initialize the Three.js renderer, scene, and camera
 */
function init3DRenderer() {
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
        window.use3DRenderer = false;
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
    renderer3d.toneMapping = THREE.ACESFilmicToneMapping;
    renderer3d.toneMappingExposure = 1;

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
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.3);
    scene3d.add(ambientLight);

    // KEY LIGHT - Main light, warm color, casts shadows
    // Positioned front-right, above the scene
    keyLight = new THREE.SpotLight(0xffeedd);  // Warm white
    keyLight.angle = Math.PI / 4;  // Cone angle (45 degrees)
    keyLight.penumbra = 0.5;  // Soft edge falloff
    keyLight.decay = 0.5;  // Light decay with distance
    keyLight.castShadow = true;

    // Shadow settings for spot light
    keyLight.shadow.mapSize.width = 2048;
    keyLight.shadow.mapSize.height = 2048;
    keyLight.shadow.camera.near = 100;
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
    fillLight = new THREE.DirectionalLight(0xddeeff, 1);  // Cool blue-white
    fillLight.castShadow = false;  // Fill light doesn't cast shadows
    scene3d.add(fillLight);

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
    addInstancedUvRotation(spriteMaterial);

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
 * Parse a color string, handling #RRGGBBAA format with alpha.
 * Returns { red, green, blue, alpha, transmission }
 */
function parseColorWithAlpha(colorStr) {
    if (!colorStr) return { red: 0, green: 0, blue: 0, alpha: 0, transmission: 0 };
    const str = colorStr.toLowerCase().trim();

    // Check for 8-character hex with alpha (#RRGGBBAA)
    if (str.match(/^#[0-9a-f]{8}$/)) {
        const r = parseInt(str.slice(1, 3), 16) / 255;
        const g = parseInt(str.slice(3, 5), 16) / 255;
        const b = parseInt(str.slice(5, 7), 16) / 255;
        const a = parseInt(str.slice(7, 9), 16) / 255;
        const transmission = 1-a;
        return { red: r, green: g, blue: b, alpha: a, transmission };
    }

    // Check for 4-character hex with alpha (#RGBA)
    if (str.match(/^#[0-9a-f]{4}$/)) {
        const r = parseInt(str[1] + str[1], 16) / 255;
        const g = parseInt(str[2] + str[2], 16) / 255;
        const b = parseInt(str[3] + str[3], 16) / 255;
        const a = parseInt(str[4] + str[4], 16) / 255;
        const transmission = 1-a;
        return { red: r, green: g, blue: b, alpha: a, transmission };
    }

    // Standard color parsing (no alpha or full opacity)
    try {
        const color = new THREE.Color(str);
        return { red: color.r, green: color.g, blue: color.b, alpha: 1.0, transmission: 0 };
    } catch (e) {
        return { red: 0, green: 0, blue: 0, alpha: 0, transmission: 0 };
    }
}

/**
 * Check if a pixel in the sprite is filled (non-transparent)
 */
function isPixelFilled(spriteData, colors, px, py, width, height) {
    if (px < 0 || px >= width || py < 0 || py >= height) return false;
    const colorIndex = spriteData[py][px];
    if (colorIndex < 0) return false;
    const color = colors[colorIndex];
    if (!color || color === 'transparent') return false;
    const parsed = parseColorWithAlpha(color);
    return parsed.alpha > 0;
}

/**
 * Get or create a merged geometry for a sprite (all cubes combined with vertex colors)
 * Implements rounded edges based on neighbor occupancy for claymation look
 */
function getOrCreateSpriteGeometry(spriteIndex) {
    if (spriteGeometries[spriteIndex]) {
        return spriteGeometries[spriteIndex];
    }

    if (!objectSprites || !objectSprites[spriteIndex]) return null;

    const sprite = objectSprites[spriteIndex];
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

    // Find minimum alpha value across all colors in the sprite
    let transmission = 0.0;
    for (const c of colors) {
        if (c && c !== 'transparent') {
            const parsed = parseColorWithAlpha(c);
            if (parsed.alpha < 1 && parsed.transmission > transmission) {
                transmission = parsed.transmission;
            }
        }
    }
    spriteTransmission[spriteIndex] = transmission;

    // Create merged geometry
    const positions = [];
    const normals = [];
    const vertexColors = [];
    const uvs = [];
    const indices = [];

    const halfSize = CUBE_SIZE / 2;
    const halfSizeVertical = SPRITE_HEIGHT * CUBE_SIZE * state.sprite_size / 2;
    const bevel = CUBE_SIZE * 0.25;  // Bevel size for rounding
    const uvScale = 0.1;  // Scale factor for UV tiling

    let vertexOffset = 0;

    // Helper to add a vertex with UV based on position
    function addVertex(x, y, z, nx, ny, nz, color) {
        positions.push(x, y, z);
        normals.push(nx, ny, nz);
        if (transmission === 0) {
            vertexColors.push(color.red, color.green, color.blue);
        } else {
            const scale = c => c + (1 - c) * color.transmission;
            vertexColors.push(scale(color.red), scale(color.green), scale(color.blue));
        }
        // UV coordinates: use x+y for u, z+y for v (so vertical faces get texture too)
        const u = (x + y) * uvScale;
        const v = (z + y) * uvScale;
        uvs.push(u, v);
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
            const parsedColor = parseColorWithAlpha(color);

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
            const innerTopY = halfSizeVertical;              // Top face stays at full height
            const outerTopY = halfSizeVertical - bevel;      // Outer edge is lowered by bevel
            const outerBotY = -halfSizeVertical + bevel;     // Outer bottom edge is raised by bevel
            const innerBotY = -halfSizeVertical;             // Bottom face at full depth

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
            // Also track which segments are exposed (need vertical walls)
            let outerVerts = [];
            let outerEdgeExposed = [];  // true if segment from outerVerts[i] to outerVerts[i+1] needs walls

            // Back-left corner
            if (cornerBackLeft && (bevelLeft || bevelBack)) {
                if (bevelLeft) {
                    outerVerts.push([blX, blZ + bevel]);
                    outerEdgeExposed.push(true);  // Corner bevel segment
                }
                if (bevelBack) {
                    outerVerts.push([blX + bevel, blZ]);
                    outerEdgeExposed.push(true);  // Back edge starts here
                }
            } else {
                outerVerts.push([blX, blZ]);
                outerEdgeExposed.push(bevelBack);  // Back edge
            }

            // Back-right corner
            if (cornerBackRight && (bevelRight || bevelBack)) {
                if (bevelBack) {
                    outerVerts.push([brX - bevel, brZ]);
                    outerEdgeExposed.push(true);  // Corner bevel segment
                }
                if (bevelRight) {
                    outerVerts.push([brX, brZ + bevel]);
                    outerEdgeExposed.push(true);  // Right edge starts here
                }
            } else {
                outerVerts.push([brX, brZ]);
                outerEdgeExposed.push(bevelRight);  // Right edge
            }

            // Front-right corner
            if (cornerFrontRight && (bevelRight || bevelFront)) {
                if (bevelRight) {
                    outerVerts.push([frX, frZ - bevel]);
                    outerEdgeExposed.push(true);  // Corner bevel segment
                }
                if (bevelFront) {
                    outerVerts.push([frX - bevel, frZ]);
                    outerEdgeExposed.push(true);  // Front edge starts here
                }
            } else {
                outerVerts.push([frX, frZ]);
                outerEdgeExposed.push(bevelFront);  // Front edge
            }

            // Front-left corner
            if (cornerFrontLeft && (bevelLeft || bevelFront)) {
                if (bevelFront) {
                    outerVerts.push([flX + bevel, flZ]);
                    outerEdgeExposed.push(true);  // Corner bevel segment
                }
                if (bevelLeft) {
                    outerVerts.push([flX, flZ - bevel]);
                    outerEdgeExposed.push(true);  // Left edge (wraps to start)
                }
            } else {
                outerVerts.push([flX, flZ]);
                outerEdgeExposed.push(bevelLeft);  // Left edge (wraps to start)
            }

            // ===== INNER TOP FACE =====
            const topStartIdx = positions.length / 3;
            for (const v of innerVerts) {
                addVertex(v[0], innerTopY, v[1], 0, 1, 0, parsedColor);
            }
            for (let i = 1; i < innerVerts.length - 1; i++) {
                indices.push(topStartIdx, topStartIdx + i + 1, topStartIdx + i);
            }

            // ===== TOP BEVEL STRIP =====
            // Connect inner perimeter (at innerTopY) to outer perimeter (at outerTopY)
            // Only generate bevels for exposed edges
            const n = innerVerts.length;
            for (let i = 0; i < n; i++) {
                if (!outerEdgeExposed[i]) continue;  // Skip internal edges

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
                addVertex(inner1[0], innerTopY, inner1[1], nx, ny, nz, parsedColor);
                addVertex(inner2[0], innerTopY, inner2[1], nx, ny, nz, parsedColor);
                addVertex(outer2[0], outerTopY, outer2[1], nx, ny, nz, parsedColor);
                addVertex(outer1[0], outerTopY, outer1[1], nx, ny, nz, parsedColor);
                indices.push(bevelStartIdx, bevelStartIdx + 1, bevelStartIdx + 2);
                indices.push(bevelStartIdx, bevelStartIdx + 2, bevelStartIdx + 3);
            }

            // ===== VERTICAL SIDES =====
            // Connect outer perimeter at outerTopY to outer perimeter at outerBotY
            // Only generate walls for exposed edges (where outerEdgeExposed is true)
            for (let i = 0; i < n; i++) {
                if (!outerEdgeExposed[i]) continue;  // Skip internal edges

                const i2 = (i + 1) % n;
                const t1 = outerVerts[i];
                const t2 = outerVerts[i2];

                const dx = t2[0] - t1[0];
                const dz = t2[1] - t1[1];
                const len = Math.sqrt(dx * dx + dz * dz);
                const nx = dz / len;
                const nz = -dx / len;

                const sideStartIdx = positions.length / 3;
                addVertex(t1[0], outerTopY, t1[1], nx, 0, nz, parsedColor);
                addVertex(t2[0], outerTopY, t2[1], nx, 0, nz, parsedColor);
                addVertex(t2[0], outerBotY, t2[1], nx, 0, nz, parsedColor);
                addVertex(t1[0], outerBotY, t1[1], nx, 0, nz, parsedColor);
                indices.push(sideStartIdx, sideStartIdx + 1, sideStartIdx + 2);
                indices.push(sideStartIdx, sideStartIdx + 2, sideStartIdx + 3);
            }

            // ===== BOTTOM BEVEL STRIP =====
            // Connect outer perimeter (at outerBotY) to inner perimeter (at innerBotY)
            // Only generate bevels for exposed edges
            for (let i = 0; i < n; i++) {
                if (!outerEdgeExposed[i]) continue;  // Skip internal edges

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
                addVertex(outer1[0], outerBotY, outer1[1], nx, ny, nz, parsedColor);
                addVertex(outer2[0], outerBotY, outer2[1], nx, ny, nz, parsedColor);
                addVertex(inner2[0], innerBotY, inner2[1], nx, ny, nz, parsedColor);
                addVertex(inner1[0], innerBotY, inner1[1], nx, ny, nz, parsedColor);
                indices.push(bevelStartIdx, bevelStartIdx + 1, bevelStartIdx + 2);
                indices.push(bevelStartIdx, bevelStartIdx + 2, bevelStartIdx + 3);
            }

            // ===== INNER BOTTOM FACE =====
            const botStartIdx = positions.length / 3;
            for (const v of innerVerts) {
                addVertex(v[0], innerBotY, v[1], 0, -1, 0, parsedColor);
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
    spriteTransmission = {};
    // Dispose and clear per-sprite glass materials
    for (const key in spriteGlassMaterials) {
        spriteGlassMaterials[key].dispose();
    }
    spriteGlassMaterials = {};
}

/**
 * Snapshot the current level state before a move happens.
 * Call this before processInput to enable smooth animation.
 */
function snapshotLevelState() {
    if (!curLevel || !curLevel.objects) return;
    previousLevelState = {
        objects: new Int32Array(curLevel.objects),
        width: curLevel.width,
        height: curLevel.height
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
 * Uses maximum bipartite matching to optimally pair old positions with new positions.
 * Returns array of: { objectIndex, fromPosIndex, toPosIndex }
 */
function detectMovements() {
    if (!previousLevelState || !curLevel || !curLevel.objects) return [];

    const oldMap = buildObjectPositionMap(
        previousLevelState.objects,
        previousLevelState.width,
        previousLevelState.height
    );
    const newMap = buildObjectPositionMap(
        curLevel.objects,
        curLevel.width,
        curLevel.height
    );

    const movements = [];

    // For each object type, find maximum bipartite matching between old and new positions.
    // Old positions form the left partition, new positions form the right partition.
    // Edges connect positions that are the same cell or side-by-side neighbors.
    for (const objectIndex in newMap) {
        const oldPositions = oldMap[objectIndex] || [];
        const newPositions = newMap[objectIndex];

        if (oldPositions.length === 0) continue;  // Newly spawned objects

        // Heuristic: detect simple push in a single direction.
        // If each new position that wasn't old lines up with a disappeared position
        // in a consistent direction, it's a push.
        const oldPosSet = new Set(oldPositions);
        const newPosSet = new Set(newPositions);
        const disappeared = oldPositions.filter(p => !newPosSet.has(p));
        const appeared = newPositions.filter(p => !oldPosSet.has(p));

        const width = curLevel.width;
        const height = curLevel.height;

        if (disappeared.length > 0 && disappeared.length === appeared.length) {
            // Check if all appeared positions are offset in the same direction from disappeared.
            // The distance can be greater than 1 (e.g., pushing a row of 2 crates makes distance 2).
            let consistentPush = true;
            let pushDx = null;
            let pushDy = null;

            // Sort both arrays to pair them up
            const disappearedSorted = [...disappeared].sort((a, b) => a - b);
            const appearedSorted = [...appeared].sort((a, b) => a - b);

            for (let i = 0; i < disappearedSorted.length; i++) {
                const oldPos = disappearedSorted[i];
                const newPos = appearedSorted[i];
                const oldX = (oldPos / height) | 0;
                const oldY = oldPos % height;
                const newX = (newPos / height) | 0;
                const newY = newPos % height;
                const dx = newX - oldX;
                const dy = newY - oldY;

                // Must be purely horizontal or purely vertical (not diagonal, not zero)
                if ((dx === 0) === (dy === 0)) {
                    consistentPush = false;
                    break;
                }

                // Normalize to unit direction
                const unitDx = dx === 0 ? 0 : (dx > 0 ? 1 : -1);
                const unitDy = dy === 0 ? 0 : (dy > 0 ? 1 : -1);

                if (pushDx === null) {
                    pushDx = unitDx;
                    pushDy = unitDy;
                } else if (unitDx !== pushDx || unitDy !== pushDy) {
                    consistentPush = false;
                    break;
                }
            }

            if (consistentPush && pushDx !== null) {
                // It's a simple push - move only objects along the disappearance/appearance lines
                // For each pair, trace from disappearance to appearance and move those objects
                for (let i = 0; i < disappearedSorted.length; i++) {
                    const startPos = disappearedSorted[i];
                    const endPos = appearedSorted[i];
                    const startX = (startPos / height) | 0;
                    const startY = startPos % height;
                    const endX = (endPos / height) | 0;
                    const endY = endPos % height;

                    // Walk from start to end (exclusive of end, which is the new position)
                    let x = startX;
                    let y = startY;
                    while (x !== endX || y !== endY) {
                        const oldPos = y + x * height;
                        const newX = x + pushDx;
                        const newY = y + pushDy;
                        const newPos = newY + newX * height;

                        if (oldPosSet.has(oldPos) && newPosSet.has(newPos)) {
                            movements.push({
                                objectIndex: parseInt(objectIndex),
                                fromPosIndex: oldPos,
                                toPosIndex: newPos
                            });
                        }

                        x += pushDx;
                        y += pushDy;
                    }
                }
                continue;  // Skip the general matching algorithm
            }
        }

        // Build index mappings for the bipartite graph
        const newPosToIdx = new Map();
        newPositions.forEach((pos, idx) => newPosToIdx.set(pos, idx));

        // Build adjacency lists:
        // - adjStay[oldIdx] = [newIdx] if the cell stays in place (marked/preferred edges)
        // - adj[oldIdx] = [newIdx, ...] for all reachable new positions
        const adjStay = [];
        const adj = oldPositions.map((oldPos, oldIdx) => {
            const oldX = (oldPos / previousLevelState.height) | 0;
            const oldY = oldPos % previousLevelState.height;

            const neighbors = [];
            // Check same cell (marked edge - preferred)
            if (newPosSet.has(oldPos)) {
                const stayIdx = newPosToIdx.get(oldPos);
                adjStay[oldIdx] = [stayIdx];
                neighbors.push(stayIdx);
            } else {
                adjStay[oldIdx] = [];
            }

            // Check 4 adjacent cells
            const offsets = [
                [-1, 0],  // left
                [1, 0],   // right
                [0, -1],  // up
                [0, 1],   // down
            ];

            for (const [dx, dy] of offsets) {
                const newX = oldX + dx;
                const newY = oldY + dy;
                if (newX >= 0 && newX < width && newY >= 0 && newY < height) {
                    const newPos = newY + newX * height;
                    if (newPosSet.has(newPos)) {
                        neighbors.push(newPosToIdx.get(newPos));
                    }
                }
            }
            return neighbors;
        });

        // Kuhn's algorithm (Hungarian algorithm) for maximum bipartite matching.
        // matchNew[newIdx] = oldIdx that is matched to it, or -1 if unmatched.
        // matchOld[oldIdx] = newIdx that is matched to it, or -1 if unmatched.
        const matchNew = new Array(newPositions.length).fill(-1);
        const matchOld = new Array(oldPositions.length).fill(-1);

        // Try to find an augmenting path starting from oldIdx using DFS.
        function tryAugment(oldIdx, visited) {
            for (const newIdx of adj[oldIdx]) {
                if (visited[newIdx]) continue;
                visited[newIdx] = true;

                const currentMatch = matchNew[newIdx];

                // If unmatched, we can take it
                if (currentMatch === -1) {
                    matchNew[newIdx] = oldIdx;
                    matchOld[oldIdx] = newIdx;
                    return true;
                }

                // Try to find alternative augmenting path for current match
                if (tryAugment(currentMatch, visited)) {
                    matchNew[newIdx] = oldIdx;
                    matchOld[oldIdx] = newIdx;
                    return true;
                }
            }
            return false;
        }

        // Phase 0: Handle deletions by pre-excluding old objects that can't stay in place.
        // If there are more old objects than new, some must be deleted.
        // Prefer deleting objects that have no stay-in-place option.
        const deletions = oldPositions.length - newPositions.length;
        const excluded = new Array(oldPositions.length).fill(false);
        if (deletions > 0) {
            let toDelete = deletions;
            for (let oldIdx = 0; oldIdx < oldPositions.length && toDelete > 0; oldIdx++) {
                if (adjStay[oldIdx].length === 0) {
                    excluded[oldIdx] = true;
                    toDelete--;
                }
            }
        }

        // Phase 1: Find maximum matching using all edges.
        for (let oldIdx = 0; oldIdx < oldPositions.length; oldIdx++) {
            if (excluded[oldIdx]) continue;  // Skip pre-excluded deletions
            const visited = new Array(newPositions.length).fill(false);
            tryAugment(oldIdx, visited);
        }

        // Phase 2: Improve matching by upgrading to stay-in-place edges where possible.
        // Iterate until no improvement found (greedy single-swap can miss global optimum).
        // For each swap, compare total stay count before/after to decide if we keep it.

        // Helper to count total stay edges in current matching
        function countStayEdges() {
            let count = 0;
            for (let i = 0; i < oldPositions.length; i++) {
                if (adjStay[i].length > 0 && matchOld[i] === adjStay[i][0]) count++;
            }
            return count;
        }

        // Track stay edges that were locked in during Phase 2 improvements.
        // Only these should be protected from being disrupted by later augmentations.
        const lockedStayEdges = new Set();

        let improved = true;
        while (improved) {
            improved = false;

            for (let l = 0; l < oldPositions.length; l++) {
                if (adjStay[l].length === 0) continue;  // No stay edge for this node
                const r_stay = adjStay[l][0];
                if (matchOld[l] === r_stay) continue;  // Already using stay edge

                const l_prime = matchNew[r_stay];  // Who currently has r_stay (-1 if free)
                const r_prime = matchOld[l];  // l's current match (-1 if unmatched)

                // Count stay edges before swap
                const stayCountBefore = countStayEdges();

                if (l_prime === -1) {
                    // r_stay is unmatched - just reassign l to use its stay edge
                    if (r_prime !== -1) matchNew[r_prime] = -1;
                    matchOld[l] = r_stay;
                    matchNew[r_stay] = l;
                    // This always improves (we gain a stay edge, lose nothing)
                    lockedStayEdges.add(r_stay);
                    improved = true;
                    continue;
                }

                // r_stay is matched to l_prime. Try to swap: give l the stay edge,
                // and find a new match for l_prime.

                // Save state for potential revert
                const savedMatchNew = matchNew.slice();
                const savedMatchOld = matchOld.slice();

                // Do the swap
                if (r_prime !== -1) matchNew[r_prime] = -1;
                matchOld[l] = r_stay;
                matchNew[r_stay] = l;
                matchOld[l_prime] = -1;

                // Try to find a new match for l_prime
                // Mark only stay edges that were locked in during Phase 2 as visited,
                // to prevent augmenting paths from disrupting confirmed improvements.
                const visited = new Array(newPositions.length).fill(false);
                for (const lockedIdx of lockedStayEdges) {
                    visited[lockedIdx] = true;
                }
                // Also protect the edge we just claimed
                visited[r_stay] = true;

                if (tryAugment(l_prime, visited)) {
                    // Swap succeeded - check if total stay count improved
                    const stayCountAfter = countStayEdges();
                    if (stayCountAfter > stayCountBefore) {
                        lockedStayEdges.add(r_stay);
                        improved = true;  // Keep the swap
                    } else {
                        // No improvement - revert
                        for (let i = 0; i < matchNew.length; i++) matchNew[i] = savedMatchNew[i];
                        for (let i = 0; i < matchOld.length; i++) matchOld[i] = savedMatchOld[i];
                    }
                } else {
                    // Can't find match for l_prime - revert
                    for (let i = 0; i < matchNew.length; i++) matchNew[i] = savedMatchNew[i];
                    for (let i = 0; i < matchOld.length; i++) matchOld[i] = savedMatchOld[i];
                }
            }
        }

        // Extract movements from the matching
        for (let newIdx = 0; newIdx < newPositions.length; newIdx++) {
            const oldIdx = matchNew[newIdx];
            if (oldIdx !== -1) {
                const oldPos = oldPositions[oldIdx];
                const newPos = newPositions[newIdx];

                if (oldPos !== newPos) {  // Object moved
                    movements.push({
                        objectIndex: parseInt(objectIndex),
                        fromPosIndex: oldPos,
                        toPosIndex: newPos
                    });
                }
            }
        }
    }

    return movements;
}

/**
 * Animation loop for smooth movement transitions
 */
function animate3D() {
    if (!isAnimating3D || !renderer3d || !scene3d || !camera3d) {
        isAnimating3D = false;
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
        isAnimating3D = false;
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

    const sprite = objectSprites[spriteIndex];
    const obj = state.objects[state.idDict[spriteIndex]];

    // Calculate cell size
    const cellSizeX = state.sprite_size * CUBE_SIZE;
    const cellSizeZ = state.sprite_size * CUBE_SIZE;

    // Center the level around origin
    const totalWidth = visibleWidth * cellSizeX;
    const totalHeight = visibleHeight * cellSizeZ;

    const spriteOffset = obj.spriteoffset || { x: 0, y: 0 };
    const baseX = gridX * cellSizeX - totalWidth / 2 + spriteOffset.x * CUBE_SIZE;
    const baseZ = gridY * cellSizeZ - totalHeight / 2 + (state.sprite_size - sprite.dat.length) + spriteOffset.y * CUBE_SIZE;
    const baseY = layer * SPRITE_HEIGHT * CUBE_SIZE * state.sprite_size;

    // Get or create the InstancedMesh for this sprite
    let mesh = instancedMeshes[spriteIndex];
    if (!mesh) {
        // Create new InstancedMesh with generous max count
        // Use glass material with transmission based on min alpha if sprite has transparency
        const maxInstances = 1000;
        const transmission = spriteTransmission[spriteIndex];
        let material = spriteMaterial;
        if (transmission > 0) {
            // Create per-sprite glass material with transmission based on alpha
            // Lower alpha = higher transmission (more transparent)
            if (!spriteGlassMaterials[spriteIndex]) {
                spriteGlassMaterials[spriteIndex] = new THREE.MeshPhysicalMaterial({
                    vertexColors: true,
                    roughness: 0.3,
                    metalness: 0.0,
                    transmission: transmission,
                    thickness: 10 * SPRITE_HEIGHT,
                    ior: 1.5,
                    transparent: true,
                    side: THREE.DoubleSide,
                });
                addInstancedUvRotation(spriteGlassMaterials[spriteIndex]);
            }
            material = spriteGlassMaterials[spriteIndex];
        }
        mesh = new THREE.InstancedMesh(geometry, material, maxInstances);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.count = 0;
        // Add per-instance UV rotation attribute
        const uvRotations = new Float32Array(maxInstances);
        mesh.geometry.setAttribute('instanceUvRotation',
            new THREE.InstancedBufferAttribute(uvRotations, 1));
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
        // Start at animation origin (with same spriteoffset as end position)
        const startBaseX = animFrom.gridX * cellSizeX - totalWidth / 2 + spriteOffset.x * CUBE_SIZE;
        const startBaseZ = animFrom.gridY * cellSizeZ - totalHeight / 2 + (state.sprite_size - sprite.dat.length) + spriteOffset.y * CUBE_SIZE;
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

    // Set instance UV rotation based on position. Basically random, but stable.
    const uvRotAttr = mesh.geometry.getAttribute('instanceUvRotation');
    uvRotAttr.setX(instanceIndex, (baseX + baseZ * Math.E) * 1000);
    uvRotAttr.needsUpdate = true;
}

/**
 * Main 3D redraw function - replaces the 2D redraw() when in 3D mode
 */
function redraw3D() {
    if (!window.use3DRenderer || !renderer3d || !scene3d || !camera3d) {
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
    if (!curLevel || !curLevel.width || !curLevel.height) {
        renderer3d.render(scene3d, camera3d);
        return true;
    }

    // Detect level changes and clear cache when level changes
    const currentLevelId = typeof curLevelTarget !== 'undefined' ? curLevelTarget : null;
    if (currentLevelId !== lastLevelId) {
        clearScene3D();
        lastLevelId = currentLevelId;
    }

    // Detect recompilation (sprites array reference changes)
    if (typeof objectSprites !== 'undefined' && objectSprites !== lastSpritesRef) {
        clearScene3D();
        lastSpritesRef = objectSprites;
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
            var px = (playerPosition / curLevel.height) | 0;
            var py = (playerPosition % curLevel.height) | 0;
            var screenx = (px / screenwidth) | 0;
            var screeny = (py / screenheight) | 0;
            mini = screenx * screenwidth;
            minj = screeny * screenheight;
            maxi = Math.min(mini + screenwidth, curLevel.width);
            maxj = Math.min(minj + screenheight, curLevel.height);
        }
    } else if (zoomscreen) {
        var playerPositions = getPlayerPositions();
        if (playerPositions.length > 0) {
            var playerPosition = playerPositions[0];
            var px = (playerPosition / curLevel.height) | 0;
            var py = (playerPosition % curLevel.height) | 0;
            mini = Math.max(Math.min(px - ((screenwidth / 2) | 0), curLevel.width - screenwidth), 0);
            minj = Math.max(Math.min(py - ((screenheight / 2) | 0), curLevel.height - screenheight), 0);
            maxi = Math.min(mini + screenwidth, curLevel.width);
            maxj = Math.min(minj + screenheight, curLevel.height);
        }
    }

    // Update camera to center on visible area
    const visibleWidth = maxi - mini;
    const visibleHeight = maxj - minj;
    cameraDistance = Math.max(visibleWidth / camera3d.aspect, visibleHeight) * state.sprite_size * CAMERA_DISTANCE;
    updateCameraPosition();

    // Update shadow camera to cover the level area
    if (keyLight) {
        const shadowSize = Math.max(visibleWidth, visibleHeight) * state.sprite_size * 0.7;

        // SpotLight uses perspective shadow camera - update far plane and distance
        keyLight.shadow.camera.near = shadowSize * 2.5 * SPRITE_HEIGHT;
        keyLight.shadow.camera.far = shadowSize * 15 * SPRITE_HEIGHT;
        keyLight.shadow.camera.updateProjectionMatrix();

        // Position key light relative to level center (front-right-above)
        keyLight.position.set(shadowSize * 0.8, shadowSize * 3 * SPRITE_HEIGHT, shadowSize * 0.6);
        keyLight.target.position.set(0, 0, 0);
        keyLight.power = 10 * Math.pow(shadowSize, 0.5);  // Scale power with shadow area for consistent brightness

        // Update fill light position (front-left)
        if (fillLight) {
            fillLight.position.set(-shadowSize * 0.6, shadowSize * 0.5, shadowSize * 0.4);
        }
    }

    // Create ground plane to receive shadows
    if (!groundPlane) {
        const groundGeometry = new THREE.PlaneGeometry(1000, 1000);
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

    // Helper function to find which collision layer group an object belongs to
    function getCollisionGroupIndex(objectId) {
        for (let g = 0; g < state.collisionLayerGroups.length; g++) {
            const group = state.collisionLayerGroups[g];
            if (objectId >= group.firstObjectNo && objectId < group.firstObjectNo + group.numObjects) {
                return g;
            }
        }
        return -1;
    }

    for (let i = mini; i < maxi; i++) {
        for (let j = minj; j < maxj; j++) {
            const posIndex = j + i * curLevel.height;
            const posMask = curLevel.getCellInto(posIndex, _o12);
            let height = 0;
            let lastGroupIndex = -1;

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

                    // When there are multiple collision layer groups, use them for layering.
                    const groupIndex = getCollisionGroupIndex(k);
                    if (state.collisionLayerGroups.length <= 1 || groupIndex !== lastGroupIndex) {
                        height += 1;
                    } else {
                        height += 0.1;
                    }
                    lastGroupIndex = groupIndex;

                    createSprite3D(k, i - mini, j - minj, height, visibleWidth, visibleHeight, animFrom);
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
        isAnimating3D = true;
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
    window.use3DRenderer = !window.use3DRenderer;

    const canvas2d = document.getElementById('gameCanvas');
    const canvas3d = document.getElementById('gameCanvas3D');

    if (window.use3DRenderer) {
        if (!renderer3d) {
            if (!init3DRenderer()) {
                // Init failed, stay in 2D mode
                window.use3DRenderer = false;
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

    console.log('Rendering mode: ' + (window.use3DRenderer ? '3D' : '2D'));
}

// Keyboard shortcuts for camera control
document.addEventListener('keydown', function(e) {
    // Toggle 3D mode with Ctrl+3 or Cmd+3 (works even without renderer initialized)
    if (e.key === '3' && (e.ctrlKey || e.metaKey)) {
        toggle3DRenderer();
        e.preventDefault();
        return;
    }

    if (!window.use3DRenderer || !renderer3d) return;

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

// Allow access from other files.
window.redraw3D = redraw3D;
window.snapshotLevelState = snapshotLevelState;
window.use3DRenderer = true;
