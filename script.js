// --- Firebase Imports ---
        import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
        import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged, setPersistence, browserLocalPersistence, signOut } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
        import { getFirestore, doc, setDoc, onSnapshot, getDoc, updateDoc, setLogLevel } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";
        
        // --- Global Firebase & Game Variables ---
        let app;
        let db;
        let auth;
        let userId;
        const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
        const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
        const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;
        
        // Game State (Default Values)
        let player = {
            x: 0, 
            y: 0, 
            size: 28.8,
            inventory: { iron: 0, copper: 0, factory: 0, upgrader: 0, generator: 0 }
        };
        let score = 0;
        let upgraderPower = 1;
        let upgraderPowerCost = 100;

        let grid = new Map(); // Grid buildings
        let items = []; // Coins
        let resources = new Map(); // World resources
        let generatedChunks = new Set(); // To track generated chunks

        // Game Constants
        const TILE_SIZE = 48;
        const CHUNK_SIZE = 16;
        const PLAYER_SPEED = 5.0; // INCREASED PLAYER SPEED from 2.5 to 5.0
        const GAME_TICK_RATE = 1000;
        
        // Utility
        let camera = { x: 0, y: 0 };
        let joystick = { active: false, x: 0, y: 0, baseX: 0, baseY: 0, radius: 60, knobRadius: 30 };
        let lastTickTime = 0;
        let currentBuildType = null;
        let messageTimer = null;
        let saveTimer; // For periodic saving
        let isAuthReady = false;
        
        // --- DOM Elements ---
        const canvas = document.getElementById('game-canvas');
        const ctx = canvas.getContext('2d');
        const loadingScreen = document.getElementById('loading-screen');
        
        // UI Elements
        const scoreDisplay = document.getElementById('score-display');
        const ironDisplay = document.getElementById('iron-display');
        const copperDisplay = document.getElementById('copper-display');
        const factoryDisplay = document.getElementById('factory-display');
        const upgraderDisplay = document.getElementById('upgrader-display');
        const generatorDisplay = document.getElementById('generator-display');
        const buildMenu = document.getElementById('build-menu');
        const craftButton = document.getElementById('craft-button');
        const craftModal = document.getElementById('craft-modal');
        const closeModal = document.getElementById('close-modal');
        const craftRecipeButtons = document.querySelectorAll('.craft-button');
        const messageBox = document.getElementById('message-box');
        const shopButton = document.getElementById('shop-button');
        const shopModalBackdrop = document.getElementById('shop-modal-backdrop');
        const closeShopModal = document.getElementById('close-shop-modal');
        const upgradePowerButton = document.getElementById('upgrade-power-button');
        const upgraderPowerDisplay = document.getElementById('upgrader-power-display');
        const upgraderCostDisplay = document.getElementById('upgrader-cost-display');
        const joystickArea = document.getElementById('joystick-area');
        const joystickKnob = document.getElementById('joystick-knob');
        
        // --- Firebase Integration ---

        /**
         * Initializes Firebase and authenticates the user.
         */
        async function initFirebase() {
            if (!firebaseConfig) {
                console.error("Firebase config is missing. Game cannot save.");
                return;
            }

            try {
                // setLogLevel('debug'); // Uncomment for debugging
                app = initializeApp(firebaseConfig);
                db = getFirestore(app);
                auth = getAuth(app);

                // Sign in using the custom token or anonymously
                if (initialAuthToken) {
                    await signInWithCustomToken(auth, initialAuthToken);
                } else {
                    await signInAnonymously(auth);
                }

                // Wait for auth state to be resolved
                await new Promise(resolve => {
                    const unsubscribe = onAuthStateChanged(auth, (user) => {
                        if (user) {
                            userId = user.uid;
                            isAuthReady = true;
                            unsubscribe();
                            resolve();
                        } else {
                            // Should not happen if sign-in was successful, but handle fallback
                            userId = crypto.randomUUID();
                            isAuthReady = true;
                            unsubscribe();
                            resolve();
                        }
                    });
                });

                // Start data listener and the game
                listenForGameData();
                startPeriodicSave();
                
            } catch (error) {
                console.error("Firebase initialization or authentication failed:", error);
                loadingScreen.innerHTML = `
                    <div style="color: #e74c3c;">Initialization Error</div>
                    <p style="font-size: 14px;">Game cannot load or save. Check console for details.</p>
                `;
            }
        }

        /**
         * Sets up a real-time listener for the game data document.
         */
        function listenForGameData() {
            if (!isAuthReady) return;

            const gameRef = doc(db, `/artifacts/${appId}/users/${userId}/game_data`, 'factory_game_state');
            
            onSnapshot(gameRef, (docSnap) => {
                if (docSnap.exists()) {
                    loadGame(docSnap.data());
                } else {
                    // Start new game with default/initial state
                    initGameDefaults();
                    saveGame(); // Save initial state immediately
                }
                loadingScreen.style.display = 'none'; // Hide loading screen once data is processed
            }, (error) => {
                console.error("Error listening to game data:", error);
                showMessage("Data sync error!");
                loadingScreen.style.display = 'none';
            });
        }

        /**
         * Initializes game state variables to their starting values.
         */
        function initGameDefaults() {
            score = 0;
            upgraderPower = 1;
            upgraderPowerCost = 100;
            grid = new Map();
            items = [];
            resources = new Map();
            generatedChunks = new Set();
            player.x = TILE_SIZE * 0; // Start near the center
            player.y = TILE_SIZE * 0;
            player.inventory = { iron: 0, copper: 0, factory: 0, upgrader: 0, generator: 0 };
            updateUI();
            updateShopUI();
        }

        /**
         * Loads game state from Firestore data.
         * @param {Object} data - The document data from Firestore.
         */
        function loadGame(data) {
            score = data.score || 0;
            upgraderPower = data.upgraderPower || 1;
            upgraderPowerCost = data.upgraderPowerCost || 100;

            // Load player state
            player.x = data.player?.x || TILE_SIZE * 0;
            player.y = data.player?.y || TILE_SIZE * 0;
            player.inventory = data.player?.inventory || { iron: 0, copper: 0, factory: 0, upgrader: 0, generator: 0 };
            
            // Convert array back to Map for grid and resources
            grid = new Map(data.grid.map(item => [item.key, { type: item.type, direction: item.direction, cooldown: item.cooldown, resourceType: item.resourceType }]));
            resources = new Map(data.resources.map(item => [item.key, { type: item.type, color: item.color }]));
            
            // Load items (coins)
            items = data.items || [];
            
            // Load generated chunks
            generatedChunks = new Set(data.generatedChunks || []);

            updateUI();
            updateShopUI();
            // The main game loop handles rendering
        }

        /**
         * Saves the current game state to Firestore.
         */
        async function saveGame() {
            if (!isAuthReady) return;

            // Prepare Maps for storage (convert to array of {key, value} objects)
            const serializableGrid = Array.from(grid.entries()).map(([key, value]) => ({ key, ...value }));
            const serializableResources = Array.from(resources.entries()).map(([key, value]) => ({ key, ...value }));
            const serializableGeneratedChunks = Array.from(generatedChunks);

            const gameStateData = {
                score,
                upgraderPower,
                upgraderPowerCost,
                player: player,
                grid: serializableGrid,
                items: items,
                resources: serializableResources,
                generatedChunks: serializableGeneratedChunks,
                updatedAt: Date.now()
            };

            const gameRef = doc(db, `/artifacts/${appId}/users/${userId}/game_data`, 'factory_game_state');
            
            try {
                await setDoc(gameRef, gameStateData);
            } catch (error) {
                console.error("Error saving game state:", error);
            }
        }
        
        /**
         * Starts the periodic saving of game state.
         */
        function startPeriodicSave() {
            // Save every 5 seconds
            saveTimer = setInterval(() => {
                saveGame();
            }, 5000); 
        }

        // --- Core Game Logic ---

        function init() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            
            // Start Firebase initialization
            initFirebase();
            
            setupEventListeners();
            updateUI();
            updateShopUI();
            gameLoop(0); // Start the game loop
        }
        
        /**
         * Generates resources for a specific chunk if it hasn't been generated before.
         * @param {number} chunkX - The chunk's X coordinate.
         * @param {number} chunkY - The chunk's Y coordinate.
         */
        function generateChunk(chunkX, chunkY) {
            const chunkKey = `${chunkX},${chunkY}`;
            if (generatedChunks.has(chunkKey)) {
                return; // Already generated
            }
            generatedChunks.add(chunkKey);
            
            const startX = chunkX * CHUNK_SIZE;
            const startY = chunkY * CHUNK_SIZE;
            
            for (let y = 0; y < CHUNK_SIZE; y++) {
                for (let x = 0; x < CHUNK_SIZE; x++) {
                    const worldX = startX + x;
                    const worldY = startY + y;
                    
                    // Don't spawn resources in the starting area
                    if (Math.abs(worldX) < 10 && Math.abs(worldY) < 10) {
                        continue;
                    }

                    const resourceKey = `${worldX},${worldY}`;

                    // Spawn iron
                    if (Math.random() < 0.03) { // 3% chance
                        if (!resources.has(resourceKey)) { // Check if not already occupied
                            resources.set(resourceKey, { type: 'iron', color: '#7f8c8d' });
                        }
                    } 
                    // Spawn copper
                    else if (Math.random() < 0.02) { // 2% chance
                        if (!resources.has(resourceKey)) {
                            resources.set(resourceKey, { type: 'copper', color: '#e67e22' });
                        }
                    }
                }
            }
            saveGame(); // Save after generating new chunks
        }

        // --- Event Listeners ---
        function setupEventListeners() {
            window.addEventListener('resize', () => {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight;
                // Recalculate joystick base on resize
                let rect = joystickArea.getBoundingClientRect();
                joystick.baseX = rect.left + rect.width / 2;
                joystick.baseY = rect.top + rect.height / 2;
            });

            // Joystick Events
            joystickArea.addEventListener('touchstart', handleJoystickStart, { passive: false });
            joystickArea.addEventListener('touchmove', handleJoystickMove, { passive: false });
            joystickArea.addEventListener('touchend', handleJoystickEnd, { passive: false });
            joystickArea.addEventListener('touchcancel', handleJoystickEnd, { passive: false });

            // Build Menu
            buildMenu.addEventListener('click', (e) => {
                const button = e.target.closest('.build-button');
                if (!button) return;
                
                document.querySelectorAll('.build-button.selected').forEach(b => b.classList.remove('selected'));
                
                const type = button.dataset.type;
                if (currentBuildType === type) {
                    currentBuildType = null; // Toggle off
                } else {
                    currentBuildType = type;
                    button.classList.add('selected');
                }
            });
            
            // Canvas Click (Building)
            canvas.addEventListener('click', (e) => {
                if (!currentBuildType) return;
                
                const [worldX, worldY] = screenToWorld(e.clientX, e.clientY);
                const gridX = Math.floor(worldX / TILE_SIZE);
                const gridY = Math.floor(worldY / TILE_SIZE);

                const buildingKey = `${gridX},${gridY}`;
                const resourceKey = `${gridX},${gridY}`;
                
                const existingBuilding = grid.get(buildingKey);
                const existingResource = resources.get(resourceKey);
                
                let wasPlacedOrRemoved = false;

                if (currentBuildType === 'remove') {
                    if (existingBuilding) {
                        if (existingBuilding.type === 'factory') player.inventory.factory++;
                        if (existingBuilding.type === 'upgrader') player.inventory.upgrader++;
                        if (existingBuilding.type === 'generator') player.inventory.generator++;
                        grid.delete(buildingKey);
                        wasPlacedOrRemoved = true;
                    }
                } else if (currentBuildType === 'mine') {
                    if (existingResource) {
                        player.inventory[existingResource.type]++;
                        resources.delete(resourceKey);
                        wasPlacedOrRemoved = true;
                    } else {
                        showMessage("Nothing to mine!");
                    }
                } else if (currentBuildType === 'rotate') {
                    if (existingBuilding && (existingBuilding.type === 'conveyor' || existingBuilding.type === 'upgrader')) {
                        existingBuilding.direction = (existingBuilding.direction + 1) % 4;
                        wasPlacedOrRemoved = true; // Rotation counts as an update
                    } else {
                        showMessage("Can only rotate conveyors/upgraders!");
                    }
                } else if (currentBuildType === 'generator') {
                    if (existingBuilding) {
                        showMessage("Cannot build here!");
                    } else if (!existingResource) {
                        showMessage("Must place on a resource node!");
                    } else if (player.inventory.generator <= 0) {
                        showMessage("No generators in inventory!");
                    } else {
                        player.inventory.generator--;
                        grid.set(buildingKey, { type: 'generator', resourceType: existingResource.type });
                        wasPlacedOrRemoved = true;
                    }
                } else if (currentBuildType === 'factory' || currentBuildType === 'upgrader' || currentBuildType === 'conveyor' || currentBuildType === 'collector') {
                    if (existingBuilding || existingResource) {
                        showMessage("Cannot build here!");
                        return;
                    }
                    
                    let building = { type: currentBuildType };
                    
                    if (currentBuildType === 'factory') {
                        if (player.inventory.factory > 0) {
                            player.inventory.factory--;
                            building.cooldown = 0;
                            wasPlacedOrRemoved = true;
                        } else { showMessage("No factories in inventory!"); return; }
                    } else if (currentBuildType === 'upgrader') {
                        if (player.inventory.upgrader > 0) {
                            player.inventory.upgrader--;
                            building.direction = 0;
                            wasPlacedOrRemoved = true;
                        } else { showMessage("No upgraders in inventory!"); return; }
                    } else if (currentBuildType === 'conveyor') {
                        building.direction = 0;
                        wasPlacedOrRemoved = true;
                    } else if (currentBuildType === 'collector') {
                        wasPlacedOrRemoved = true; // Collector is free
                    }
                    
                    if (wasPlacedOrRemoved) {
                         grid.set(buildingKey, building);
                    }
                }
                
                if (wasPlacedOrRemoved) {
                    updateUI();
                    saveGame(); // Save after building/mining action
                }
            });
            
            // Action Buttons
            craftButton.addEventListener('click', () => craftModal.style.display = 'flex');
            closeModal.addEventListener('click', () => craftModal.style.display = 'none');
            
            // Shop Buttons
            shopButton.addEventListener('click', () => shopModalBackdrop.style.display = 'flex');
            closeShopModal.addEventListener('click', () => shopModalBackdrop.style.display = 'none');
            upgradePowerButton.addEventListener('click', buyUpgraderPower);

            // Crafting
            craftRecipeButtons.forEach(button => {
                button.addEventListener('click', () => {
                    craftItem(button.dataset.recipe);
                });
            });
        }
        
        function craftItem(recipe) {
            let success = false;
            if (recipe === 'factory') {
                if (player.inventory.iron >= 5 && player.inventory.copper >= 2) {
                    player.inventory.iron -= 5;
                    player.inventory.copper -= 2;
                    player.inventory.factory++;
                    showMessage("Crafted 🏭 Factory!");
                    success = true;
                } else {
                    showMessage("Need 5 Iron, 2 Copper!");
                }
            } else if (recipe === 'upgrader') {
                if (player.inventory.iron >= 10 && player.inventory.copper >= 5) {
                    player.inventory.iron -= 10;
                    player.inventory.copper -= 5;
                    player.inventory.upgrader++;
                    showMessage("Crafted 🔼 Upgrader!");
                    success = true;
                } else {
                    showMessage("Need 10 Iron, 5 Copper!");
                }
            } else if (recipe === 'generator') {
                if (player.inventory.iron >= 20 && player.inventory.copper >= 10) {
                    player.inventory.iron -= 20;
                    player.inventory.copper -= 10;
                    player.inventory.generator++;
                    showMessage("Crafted ⚙️ Generator!");
                    success = true;
                } else {
                    showMessage("Need 20 Iron, 10 Copper!");
                }
            }
            if (success) {
                updateUI();
                saveGame(); // Save after crafting
            }
        }
        
        // --- Shop Logic ---
        function buyUpgraderPower() {
            if (score >= upgraderPowerCost) {
                score -= upgraderPowerCost;
                upgraderPower++;
                upgraderPowerCost = Math.floor(upgraderPowerCost * 1.5); // Increase cost by 50%
                
                updateUI();
                updateShopUI();
                showMessage(`Upgraders now add +${upgraderPower}!`);
                saveGame(); // Save after purchase
            } else {
                showMessage("Not enough score!");
            }
        }

        function updateShopUI() {
            upgraderPowerDisplay.innerText = `Current: +${upgraderPower}`;
            upgraderCostDisplay.innerText = `${upgraderPowerCost}`;
        }

        // --- Joystick Logic (omitted for brevity, assume correct) ---
        function handleJoystickStart(e) {
            e.preventDefault();
            joystick.active = true;
            let rect = joystickArea.getBoundingClientRect();
            joystick.baseX = rect.left + rect.width / 2;
            joystick.baseY = rect.top + rect.height / 2;
            
            let touch = e.changedTouches[0];
            updateJoystickKnob(touch.clientX, touch.clientY);
        }

        function handleJoystickMove(e) {
            e.preventDefault();
            if (!joystick.active) return;
            let touch = e.changedTouches[0];
            updateJoystickKnob(touch.clientX, touch.clientY);
        }

        function handleJoystickEnd(e) {
            e.preventDefault();
            joystick.active = false;
            joystick.x = 0;
            joystick.y = 0;
            joystickKnob.style.transform = `translate(0px, 0px)`;
        }

        function updateJoystickKnob(clientX, clientY) {
            let dx = clientX - joystick.baseX;
            let dy = clientY - joystick.baseY;
            let distance = Math.sqrt(dx * dx + dy * dy);
            
            let maxDist = joystickArea.offsetWidth / 2 - joystickKnob.offsetWidth / 2;
            joystick.radius = maxDist; // Update max dist for ratio calculation

            if (distance > maxDist) {
                dx = (dx / distance) * maxDist;
                dy = (dy / distance) * maxDist;
                distance = maxDist;
            }

            joystickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
            
            joystick.x = dx / maxDist;
            joystick.y = dy / maxDist;
        }

        // --- Game Loop ---
        function gameLoop(timestamp) {
            update(timestamp);
            render();
            requestAnimationFrame(gameLoop);
        }

        function update(timestamp) {
            // Update player position
            if (joystick.active) {
                let newX = player.x + joystick.x * PLAYER_SPEED;
                let newY = player.y + joystick.y * PLAYER_SPEED;
                
                player.x = newX;
                player.y = newY;
            }
            
            // Update camera to follow player
            camera.x = player.x - canvas.width / 2;
            camera.y = player.y - canvas.height / 2;
            
            // --- Game Tick Logic ---
            if (isAuthReady && timestamp - lastTickTime > GAME_TICK_RATE) {
                lastTickTime = timestamp;
                runGameTick();
            }
        }
        
        // --- Game Tick Function ---
        function runGameTick() {
            let needsUIUpdate = false;

            // 1. Process buildings that affect items (Collectors)
            for (let i = items.length - 1; i >= 0; i--) {
                const item = items[i];
                const building = grid.get(`${item.x},${item.y}`);
                
                if (building) {
                    if (building.type === 'collector') {
                        score += item.value;
                        items.splice(i, 1);
                        needsUIUpdate = true;
                    }
                }
            }
            
            // 2. Process movement on conveyors/upgraders
            let itemsToMove = [];
            for (const item of items) {
                const building = grid.get(`${item.x},${item.y}`);
                
                if (building && (building.type === 'conveyor' || building.type === 'upgrader')) {
                    
                    if (building.type === 'upgrader' && !item.processedThisTick) {
                        item.value += upgraderPower;
                        item.processedThisTick = true;
                    }

                    let nextX = item.x, nextY = item.y;
                    let dir = building.direction;
                    
                    if (dir === 0) nextY--; // Up
                    if (dir === 1) nextX++; // Right
                    if (dir === 2) nextY++; // Down
                    if (dir === 3) nextX--; // Left
                    
                    itemsToMove.push({ item, nextX, nextY });
                }

                item.processedThisTick = false;
                item.mergedThisTick = false;
            }
            
            // 3. Apply moves
            for (const move of itemsToMove) {
                move.item.x = move.nextX;
                move.item.y = move.nextY;
                checkAndMergeAt(move.item.x, move.item.y);
            }

            // 4. Process factories (spawn new items)
            for (const [key, building] of grid.entries()) {
                if (building.type === 'factory') {
                    building.cooldown--;
                    if (building.cooldown <= 0) {
                        const [x, y] = key.split(',').map(Number);
                        
                        const neighbors = [
                            { nx: x, ny: y - 1 }, { nx: x, ny: y + 1 },
                            { nx: x + 1, ny: y }, { nx: x - 1, ny: y }
                        ];
                        
                        let spawnLocation = null;
                        
                        for (const n of neighbors) {
                            const neighborBuilding = grid.get(`${n.nx},${n.ny}`);
                            if (neighborBuilding && (neighborBuilding.type === 'conveyor' || neighborBuilding.type === 'collector')) {
                                spawnLocation = n;
                                break;
                            }
                        }

                        if (spawnLocation) {
                            building.cooldown = 5;
                            items.push({ x: spawnLocation.nx, y: spawnLocation.ny, value: 1, id: Math.random() });
                            checkAndMergeAt(spawnLocation.nx, spawnLocation.ny);
                        } else {
                            building.cooldown = 0; 
                        }
                    }
                }
            }
            
            // 5. Process generators
            for (const [key, building] of grid.entries()) {
                if (building.type === 'generator') {
                    player.inventory[building.resourceType]++;
                    needsUIUpdate = true;
                }
            }
            
            if (needsUIUpdate) {
                updateUI();
                saveGame(); // Save after score or inventory changes (generation/collection)
            }
        }
        // --- End Game Tick Function ---


        // --- Merge Function ---
        function checkAndMergeAt(x, y) {
            const itemsOnTile = items.filter(item => item.x === x && item.y === y);

            if (itemsOnTile.length > 1) {
                let firstItem = itemsOnTile[0];
                let totalValue = 0;
                // Use a Set to track items to remove
                const itemsToRemove = new Set(); 
                
                for (const item of itemsOnTile) {
                    totalValue += item.value;
                    if (item !== firstItem) {
                        itemsToRemove.add(item);
                    }
                }
                
                // Update the first item with the total value
                firstItem.value = totalValue;

                // Filter the global items array to remove merged coins
                items = items.filter(item => !itemsToRemove.has(item));
            }
        }


        // --- Rendering ---
        function render() {
            if (!isAuthReady || loadingScreen.style.display !== 'none') {
                return; // Don't render game until data is loaded
            }

            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            
            ctx.translate(-camera.x, -camera.y);

            // --- Draw Grid & World Boundaries ---
            const startX = Math.floor(camera.x / TILE_SIZE);
            const startY = Math.floor(camera.y / TILE_SIZE);
            const endX = startX + Math.ceil(canvas.width / TILE_SIZE) + 1;
            const endY = startY + Math.ceil(canvas.height / TILE_SIZE) + 1;

            // --- Generate Chunks ---
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const chunkX = Math.floor(x / CHUNK_SIZE);
                    const chunkY = Math.floor(y / CHUNK_SIZE);
                    const chunkKey = `${chunkX},${chunkY}`;
                    if (!generatedChunks.has(chunkKey)) {
                        generateChunk(chunkX, chunkY);
                    }
                }
            }

            // Draw grid lines
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
            ctx.lineWidth = 1;
            for (let x = startX; x < endX; x++) {
                ctx.beginPath();
                ctx.moveTo(x * TILE_SIZE, startY * TILE_SIZE);
                ctx.lineTo(x * TILE_SIZE, endY * TILE_SIZE);
                ctx.stroke();
            }
            for (let y = startY; y < endY; y++) {
                ctx.beginPath();
                ctx.moveTo(startX * TILE_SIZE, y * TILE_SIZE);
                ctx.lineTo(endX * TILE_SIZE, y * TILE_SIZE);
                ctx.stroke();
            }

            // Draw resources
            for (const [key, res] of resources.entries()) {
                const [x, y] = key.split(',').map(Number);
                if (x >= startX && x <= endX && y >= startY && y <= endY) {
                    ctx.fillStyle = res.color;
                    ctx.fillRect(x * TILE_SIZE + 4, y * TILE_SIZE + 4, TILE_SIZE - 8, TILE_SIZE - 8);
                    ctx.fillStyle = 'white';
                    ctx.font = 'bold 12px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText(res.type === 'iron' ? '⛏️' : '🟠', x * TILE_SIZE + TILE_SIZE / 2, y * TILE_SIZE + TILE_SIZE / 2 + 5);
                }
            }

            // Draw buildings
            for (let y = startY; y < endY; y++) {
                for (let x = startX; x < endX; x++) {
                    const building = grid.get(`${x},${y}`);
                    if (building) {
                        drawBuilding(x, y, building);
                    }
                }
            }

            // Draw items (coins)
            for (const item of items) {
                if (item.x >= startX && item.x <= endX && item.y >= startY && item.y <= endY) {
                    drawItem(item);
                }
            }
            
            // Draw player
            ctx.fillStyle = '#3498db';
            ctx.beginPath();
            ctx.arc(player.x, player.y, player.size / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#2980b9';
            ctx.lineWidth = 3;
            ctx.stroke();

            ctx.restore();
        }
        
        function drawBuilding(x, y, building) {
            const px = x * TILE_SIZE;
            const py = y * TILE_SIZE;
            
            switch (building.type) {
                case 'factory':
                    ctx.fillStyle = '#7f8c8d'; 
                    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
                    ctx.fillStyle = '#95a5a6';
                    ctx.fillRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8);
                    ctx.font = '24px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText('🏭', px + TILE_SIZE / 2, py + TILE_SIZE / 2 + 8);
                    break;
                case 'upgrader':
                    ctx.fillStyle = '#f39c12';
                    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
                    ctx.fillStyle = '#f1c40f';
                    ctx.fillRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8);
                    
                    let arrowUp = '🔼';
                    if (building.direction === 1) arrowUp = '▶️';
                    if (building.direction === 2) arrowUp = '🔽';
                    if (building.direction === 3) arrowUp = '◀️';
                    
                    ctx.font = '24px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText(arrowUp, px + TILE_SIZE / 2, py + TILE_SIZE / 2 + 8);
                    break;
                case 'collector':
                    ctx.fillStyle = '#2ecc71';
                    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
                    ctx.fillStyle = '#27ae60';
                    ctx.fillRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8);
                    ctx.font = '24px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText('💲', px + TILE_SIZE / 2, py + TILE_SIZE / 2 + 8);
                    break;
                case 'conveyor':
                    ctx.fillStyle = '#555';
                    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
                    ctx.fillStyle = '#777';
                    ctx.fillRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8);
                    
                    let arrow = '⬆️';
                    if (building.direction === 1) arrow = '➡️';
                    if (building.direction === 2) arrow = '⬇️';
                    if (building.direction === 3) arrow = '⬅️';
                    
                    ctx.font = 'bold 24px Arial';
                    ctx.fillStyle = 'white';
                    ctx.textAlign = 'center';
                    ctx.fillText(arrow, px + TILE_SIZE / 2, py + TILE_SIZE / 2 + 8);
                    break;
                case 'generator':
                    ctx.fillStyle = '#8e44ad';
                    ctx.fillRect(px, py, TILE_SIZE, TILE_SIZE);
                    ctx.fillStyle = '#9b59b6';
                    ctx.fillRect(px + 4, py + 4, TILE_SIZE - 8, TILE_SIZE - 8);
                    ctx.font = '24px Arial';
                    ctx.textAlign = 'center';
                    ctx.fillText('⚙️', px + TILE_SIZE / 2, py + TILE_SIZE / 2 + 8);
                    break;
            }
        }

        function drawItem(item) {
            const px = item.x * TILE_SIZE + TILE_SIZE / 2;
            const py = item.y * TILE_SIZE + TILE_SIZE / 2;
            
            ctx.fillStyle = '#f1c40f';
            ctx.beginPath();
            ctx.arc(px, py, TILE_SIZE * 0.3, 0, Math.PI * 2);
            ctx.fill();
            ctx.strokeStyle = '#f39c12';
            ctx.lineWidth = 2;
            ctx.stroke();
            
            // Draw value
            ctx.fillStyle = '#000';
            ctx.font = 'bold 12px Arial';
            ctx.textAlign = 'center';
            ctx.fillText(item.value, px, py + 4);
        }

        // --- UI Helpers ---
        function updateUI() {
            scoreDisplay.innerText = `💰 Score: ${score}`;
            ironDisplay.innerText = `⛏️ Iron: ${player.inventory.iron}`;
            copperDisplay.innerText = `🟠 Copper: ${player.inventory.copper}`;
            factoryDisplay.innerText = `🏭 Factory: ${player.inventory.factory}`;
            upgraderDisplay.innerText = `🔼 Upgrader: ${player.inventory.upgrader}`;
            generatorDisplay.innerText = `⚙️ Gen: ${player.inventory.generator}`;
        }

        function showMessage(msg) {
            if (messageTimer) {
                clearTimeout(messageTimer);
            }
            messageBox.innerText = msg;
            messageBox.style.display = 'block';
            messageTimer = setTimeout(() => {
                messageBox.style.display = 'none';
                messageTimer = null;
            }, 2000);
        }
        
        function screenToWorld(screenX, screenY) {
            const worldX = screenX + camera.x;
            const worldY = screenY + camera.y;
            return [worldX, worldY];
        }

        // --- Start ---
        init();