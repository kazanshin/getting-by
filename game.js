(() => {
  const DATA_FILES = {
    story: 'story.json',
    settings: 'settings.json',
    placements: 'placements.json',
    placementRules: 'placement_engine_rules.json',
    endings: 'endings.json',
    endingPlacements: 'ending_placements.json',
    audio: 'audio.json',
    ui: 'ui.json',
    instructions: 'instructions.json'
  };

  const STATS = ['education', 'money', 'stress', 'support', 'risk'];
  const DEBUG_MODE = true;

  const state = {
    phase: 'boot',
    currentScreenId: null,
    instructionIndex: 0,
    stats: Object.fromEntries(STATS.map((key) => [key, 0])),
    data: {},
    audio: {
      currentKey: null,
      currentEl: null,
      unlocked: false,
      pending: null,
      targetVolume: 0.5,
      fadeDurationMs: 800,
      fadeIntervalId: null,
      transitionId: 0
    }
  };

  const el = {
    game: document.getElementById('game'),
    bg: document.getElementById('background'),
    sprites: document.getElementById('sprite-layer'),
    title: document.getElementById('title'),
    text: document.getElementById('text'),
    choices: document.getElementById('choices'),
    error: document.getElementById('error')
  };

  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    await loadAllData();
    showWelcome();
  }

  async function loadAllData() {
    const entries = await Promise.all(
      Object.entries(DATA_FILES).map(async ([key, path]) => [key, await loadJson(path)])
    );
    state.data = Object.fromEntries(entries);
  }

  async function loadJson(path) {
    try {
      const response = await fetch(path);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${path}`);
      const text = await response.text();
      return safeParseJson(text, path);
    } catch (error) {
      console.error(`Failed to load ${path}`, error);
      showError(`Unable to load ${path}. Some content may be missing.`);
      return {};
    }
  }

  function safeParseJson(text, path) {
    try {
      return JSON.parse(text);
    } catch (error) {
      if (path === 'endings.json') {
        try {
          return JSON.parse(`${text.trim()}\n}`);
        } catch (error2) {
          console.error(`JSON parse error in ${path}`, error2);
          showError(`Data format issue in ${path}. Ending visuals may be limited.`);
          return {};
        }
      }
      console.error(`JSON parse error in ${path}`, error);
      showError(`Data format issue in ${path}.`);
      return {};
    }
  }

  function showWelcome() {
    state.phase = 'welcome';
    el.game.classList.add('welcome-mode');
    const welcome = state.data.ui?.welcome || {};
    const welcomeImage = pickWelcomeBackground(welcome);

    setBackground(welcomeImage || welcome.background || '#000000');
    clearSprites();
    el.title.textContent = extractUiContentById(welcome.ui_elements, 'title') || 'Getting By';
    el.text.textContent = extractUiContentById(welcome.ui_elements, 'subtitle') || '';

    clearChoices();
    const prompt = extractUiContentById(welcome.ui_elements, 'start_prompt') || 'Press to begin';
    addButton(prompt, () => {
      unlockAudio();
      requestAudioForScene('S01', { type: 'story' });
      showInstructions();
    }, true);

    const keyHandler = (event) => {
      if (state.phase !== 'welcome') return;
      if (event.key !== 'Enter' && event.key !== ' ' && event.key !== 'Spacebar') return;
      window.removeEventListener('keydown', keyHandler);
      unlockAudio();
      requestAudioForScene('S01', { type: 'story' });
      showInstructions();
    };
    window.addEventListener('keydown', keyHandler);
  }

  function pickWelcomeBackground(welcome) {
    const elementImage = (welcome.ui_elements || []).find((element) => element?.type === 'image' && element?.source)?.source;
    if (elementImage) return normalizePath(elementImage);

    if (typeof welcome.background === 'string' && /\.(png|jpg|jpeg|webp)$/i.test(welcome.background)) {
      return normalizePath(welcome.background);
    }

    // Asset fallback in graphics/ui for projects where ui.json keeps a color background.
    return 'graphics/ui/welcome_screen.png';
  }

  function showInstructions() {
    state.phase = 'instructions';
    el.game.classList.remove('welcome-mode');
    state.instructionIndex = 0;
    advanceInstruction();
  }

  function advanceInstruction() {
    const instructions = state.data.instructions?.instructions || [];
    if (state.instructionIndex >= instructions.length) {
      startGame();
      return;
    }

    const instruction = instructions[state.instructionIndex] || {};
    const config = state.data.ui?.instructions_screen || {};
    setBackground(normalizePath(config.background || '#000000'));
    clearSprites();
    el.title.textContent = '';
    el.text.textContent = instruction.text || '';

    clearChoices();
    addButton('Continue', () => {
      state.instructionIndex += 1;
      advanceInstruction();
    }, true);
  }

  function startGame() {
    state.phase = 'game';
    el.game.classList.remove('welcome-mode');
    state.stats = Object.fromEntries(STATS.map((key) => [key, 0]));
    goToScreen(resolveFirstStoryId());
  }

  function resolveFirstStoryId() {
    const story = state.data.story || {};
    if (story.S01) return 'S01';
    const ids = Object.keys(story).filter((id) => /^S\d+/i.test(id));
    ids.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return ids[0] || null;
  }

  function goToScreen(screenId) {
    if (!screenId) {
      showError('No valid screen found.');
      return;
    }

    if (screenId === 'ENDING_CHECK') {
      goToScreen(evaluateEnding());
      return;
    }

    const screen = state.data.story?.[screenId];
    if (!screen) {
      showError(`Missing screen: ${screenId}`);
      return;
    }

    state.currentScreenId = screenId;
    renderScreen(screenId, screen);
  }

  function renderScreen(screenId, screen) {
    const screenType = screen.type || 'story';
    setBackground(resolveBackgroundForScreen(screenId, screen));
    renderSpritesForScreen(screenId, screen);

    el.title.textContent = screen.title || '';
    el.text.textContent = screen.text || '';
    clearChoices();

    requestAudioForScene(screenId, screen);

    if (screenType === 'dilemma') {
      const choices = Array.isArray(screen.choices) ? screen.choices.slice(0, 2) : [];
      if (choices.length !== 2) showError(`Dilemma ${screenId} does not contain exactly 2 choices.`);

      choices.forEach((choice) => {
        addButton(choice?.text || 'Choose', () => {
          applyEffects(choice?.effects);
          goToScreen(choice?.next);
        });
      });

      if (choices.length === 0) addButton('Continue', () => goToScreen(screen.next), true);
      return;
    }

    if (screenType === 'ending') {
      state.phase = 'ending';
      addButton('Play Again', () => {
        hideError();
        showWelcome();
      }, true);
      return;
    }

    addButton('Continue', () => goToScreen(screen.next), true);
  }

  function resolveBackgroundForScreen(screenId, screen) {
    if (screen.type === 'ending') {
      const endingKey = screenId.replace('ENDING_', '').toLowerCase();
      const endingVisual = state.data.endings?.endings?.[endingKey];
      return endingVisual?.background || normalizePath(screen.image);
    }
    return normalizePath(screen.image);
  }

  function renderSpritesForScreen(screenId, screen) {
    clearSprites();

    if (screen.type === 'ending') {
      renderEndingSprites(screenId);
      return;
    }

    const settingKey = imagePathToSettingKey(screen.image);
    if (!settingKey) return;

    const settingDef = state.data.settings?.[settingKey];
    if (DEBUG_MODE) {
      drawCollisionDebug(settingDef);
    }
    const placementByScene = state.data.placements?.[settingKey];
    if (!placementByScene || typeof placementByScene !== 'object') {
      console.warn(`[placement] No placement object for setting="${settingKey}".`);
      return;
    }

    const explicitSceneType = screen.scene || screen.context;
    let sceneType = explicitSceneType;

    if (!sceneType) {
      if (Array.isArray(placementByScene.normal)) {
        sceneType = 'normal';
      } else {
        sceneType = Object.keys(placementByScene)[0];
      }
    }

    let entities = placementByScene?.[sceneType];
    if (!Array.isArray(entities)) {
      if (Array.isArray(placementByScene.normal)) {
        sceneType = 'normal';
        entities = placementByScene.normal;
      } else {
        const firstKey = Object.keys(placementByScene)[0];
        sceneType = firstKey;
        entities = placementByScene?.[firstKey];
      }
    }

    console.log('placement lookup', { settingKey, sceneType, entities });

    if (!Array.isArray(entities)) {
      console.warn(`[placement] No valid entity array for setting="${settingKey}", scene="${sceneType}".`);
      return;
    }

    const used = new Set();
    const resolvedSprites = [];

    entities.forEach((entity) => {
      const pos = validateOrFallbackPosition(entity.x, entity.y, settingDef, used);
      if (!pos) return;
      used.add(`${pos.x},${pos.y}`);
      resolvedSprites.push({
        sprite: entity.sprite,
        pos,
        id: entity.id || 'entity'
      });
    });

    // Draw back-to-front: top rows first, lower rows after (lower rows appear in front).
    resolvedSprites
      .sort((a, b) => a.pos.y - b.pos.y)
      .forEach((entry) => drawSprite(entry.sprite, entry.pos, settingDef?.grid_size, entry.id));
  }

  function drawCollisionDebug(settingDef) {
    if (!settingDef || !Array.isArray(settingDef.collision_map)) return;

    const map = settingDef.collision_map;
    const gridSize = settingDef.grid_size || { cols: 20, rows: 12 };
    const cols = Number(gridSize.cols) || 20;
    const rows = Number(gridSize.rows) || 12;

    map.forEach((row, y) => {
      if (!Array.isArray(row)) return;
      row.forEach((cell, x) => {
        if (cell !== 1) return;
        const div = document.createElement('div');
        div.style.position = 'absolute';
        div.style.left = `${(x / cols) * 100}%`;
        div.style.top = `${(y / rows) * 100}%`;
        div.style.width = `${100 / cols}%`;
        div.style.height = `${100 / rows}%`;
        div.style.border = '1px solid rgba(255, 0, 0, 0.5)';
        div.style.backgroundColor = 'rgba(255, 0, 0, 0.2)';
        div.style.pointerEvents = 'none';
        div.style.zIndex = '999';
        el.sprites.appendChild(div);
      });
    });
  }

  function resolveSceneEntities(settingKey, screenId) {
    const placements = state.data.placements || {};
    const candidates = [
      {
        label: 'placements[settingKey][screenId]',
        value: placements?.[settingKey]?.[screenId]
      },
      {
        label: 'placements[screenId]',
        value: placements?.[screenId]
      },
      {
        label: 'placements[settingKey].screens[screenId]',
        value: placements?.[settingKey]?.screens?.[screenId]
      },
      {
        label: 'placements[settingKey].placements[screenId]',
        value: placements?.[settingKey]?.placements?.[screenId]
      }
    ];

    for (const candidate of candidates) {
      if (Array.isArray(candidate.value)) {
        console.warn(
          `[placement] Resolved entities via ${candidate.label} for setting="${settingKey}", screen="${screenId}".`
        );
        return candidate.value;
      }
      console.warn(
        `[placement] Lookup miss: ${candidate.label} for setting="${settingKey}", screen="${screenId}".`
      );
    }

    return null;
  }

  function renderEndingSprites(screenId) {
    const endingKey = screenId.replace('ENDING_', '').toLowerCase();
    const endingMap = state.data.endings?.endings?.[endingKey];
    const endingPlacement = state.data.endingPlacements?.endings?.[endingKey];
    const global = state.data.endingPlacements?.global || {};

    if (!endingMap || !endingPlacement) return;

    const used = new Set();
    const entities = endingPlacement.entities || [];
    const resolvedSprites = [];
    console.log('ending entities', entities);
    entities.forEach((entity) => {
      const count = Math.max(1, Number(entity.count) || 1);
      for (let index = 0; index < count; index += 1) {
        const pos = pickEndingPosition(entity.zone, endingMap, used);
        if (!pos) continue;
        used.add(`${pos.x},${pos.y}`);
        const sprite = entity.sprite || (entity.id === 'player' ? global.player?.sprite : null);
        if (!sprite) {
          console.warn(`[ending] Missing sprite for entity "${entity.id || 'unknown'}".`);
          continue;
        }
        resolvedSprites.push({
          sprite,
          pos,
          id: `${entity.id || 'entity'}-${index}`
        });
      }
    });

    // Draw back-to-front: top rows first, lower rows after (lower rows appear in front).
    resolvedSprites
      .sort((a, b) => a.pos.y - b.pos.y)
      .forEach((entry) => drawSprite(entry.sprite, entry.pos, endingMap.grid_size, entry.id));
  }

  function pickEndingPosition(zoneName, endingMap, used) {
    const rules = state.data.placementRules || {};
    const zoneRules = rules.zone_rules || {};
    const placementPriority = rules.placement_priority || ['zone', 'random_valid_tile'];

    for (const step of placementPriority) {
      if (step === 'zone' && zoneRules.use_zones_if_available) {
        const pos = pickFromZone(zoneName, endingMap.zones, used);
        if (pos) return pos;
      }

      if (step === 'random_valid_tile' || (step === 'spawn_points' && zoneRules.fallback_to_any_valid_tile)) {
        const pos = pickAnyValidTile(endingMap.placement_map, used);
        if (pos) return pos;
      }
    }

    return null;
  }

  function pickFromZone(zoneName, zones, used) {
    const points = zones?.[zoneName];
    if (!Array.isArray(points) || points.length === 0) return null;
    return points.find((point) => !used.has(`${point.x},${point.y}`)) || points[0] || null;
  }

  function pickAnyValidTile(map, used) {
    if (!Array.isArray(map)) return null;
    const valid = [];

    map.forEach((row, y) => {
      if (!Array.isArray(row)) return;
      row.forEach((value, x) => {
        if (value === 1 && !used.has(`${x},${y}`)) valid.push({ x, y });
      });
    });

    if (valid.length === 0) return null;
    return valid[Math.floor(Math.random() * valid.length)];
  }

  function validateOrFallbackPosition(x, y, settingDef, used) {
    const rules = state.data.placementRules || {};
    const placementRules = rules.placement_rules || {};
    const zoneRules = rules.zone_rules || {};
    const priority = Array.isArray(rules.placement_priority)
      ? rules.placement_priority
      : ['spawn_points', 'random_valid_tile'];

    const requireValid = placementRules.must_be_valid_tile !== false;
    const noOverlap = placementRules.no_overlap !== false;
    const allowSpawnFallback =
      placementRules.fallback_to_spawn_points === true || priority.includes('spawn_points');
    const allowAnyValidFallback =
      zoneRules.fallback_to_any_valid_tile === true || priority.includes('random_valid_tile');

    const exact = { x: Number(x), y: Number(y) };
    if (isValidPosition(exact, settingDef, requireValid, used, noOverlap)) {
      return exact;
    }

    for (const step of priority) {
      if (step === 'spawn_points' && allowSpawnFallback) {
        const spawn = pickSpawnPoint(settingDef?.spawn_points, settingDef, requireValid, used, noOverlap);
        if (spawn) return spawn;
      }

      if (step === 'random_valid_tile' && allowAnyValidFallback) {
        const tile = pickAnyValidTile(settingDef?.collision_map, used);
        if (tile) return tile;
      }
    }

    if (allowSpawnFallback) {
      const spawn = pickSpawnPoint(settingDef?.spawn_points, settingDef, requireValid, used, noOverlap);
      if (spawn) return spawn;
    }

    if (allowAnyValidFallback) {
      return pickAnyValidTile(settingDef?.collision_map, used);
    }

    return null;
  }

  function pickSpawnPoint(spawnPoints, settingDef, requireValid, used, noOverlap) {
    if (!Array.isArray(spawnPoints)) return null;
    return (
      spawnPoints.find((point) => isValidPosition(point, settingDef, requireValid, used, noOverlap)) ||
      null
    );
  }

  function isValidPosition(pos, settingDef, requireValid, used, noOverlap) {
    if (!Number.isFinite(pos?.x) || !Number.isFinite(pos?.y)) return false;

    if (noOverlap && used.has(`${pos.x},${pos.y}`)) return false;

    if (!requireValid) return true;

    const row = settingDef?.collision_map?.[pos.y];
    const tile = Array.isArray(row) ? row[pos.x] : 0;
    return tile === 1;
  }

  function drawSprite(spritePath, position, gridSize, id) {
    const cols = Number(gridSize?.cols) || 20;
    const rows = Number(gridSize?.rows) || 12;
    const gameRect = el.bg.getBoundingClientRect();
    const cellWidth = gameRect.width / cols;
    const cellHeight = gameRect.height / rows;
    const spriteSize = Math.max(20, Math.min(cellWidth, cellHeight) * 1.35);

    const sprite = document.createElement('img');
    sprite.className = 'sprite';
    sprite.src = normalizePath(spritePath);
    sprite.alt = id;
    sprite.style.width = `${spriteSize}px`;
    sprite.style.height = `${spriteSize}px`;
    sprite.style.objectFit = 'contain';
    sprite.style.left = `${((position.x + 0.5) / cols) * 100}%`;
    sprite.style.top = `${((position.y + 1) / rows) * 100}%`;

    sprite.addEventListener('error', () => {
      console.warn(`Missing sprite asset: ${spritePath}`);
      sprite.remove();
    });

    el.sprites.appendChild(sprite);
  }

  function imagePathToSettingKey(path) {
    if (typeof path !== 'string') return null;
    const parts = path.split('/');
    const file = parts[parts.length - 1] || '';
    return file.replace(/\.[^.]+$/, '');
  }

  function clearSprites() {
    el.sprites.innerHTML = '';
  }

  function normalizePath(path) {
    if (!path || typeof path !== 'string') return '#000000';
    return path.startsWith('/') ? path.slice(1) : path;
  }

  function setBackground(pathOrColor) {
    if (!pathOrColor) {
      el.bg.style.backgroundImage = 'none';
      el.bg.style.backgroundColor = '#000';
      return;
    }

    if (pathOrColor.startsWith('#')) {
      el.bg.style.backgroundImage = 'none';
      el.bg.style.backgroundColor = pathOrColor;
      return;
    }

    el.bg.style.backgroundColor = '#000';
    el.bg.style.backgroundImage = `url('${pathOrColor}')`;
  }

  function applyEffects(effects) {
    if (!effects || typeof effects !== 'object') return;
    STATS.forEach((key) => {
      const value = Number(effects[key]);
      if (!Number.isNaN(value)) state.stats[key] += value;
    });
  }

  function evaluateEnding() {
    const story = state.data.story || {};
    const endingIds = Object.keys(story).filter((id) => story[id]?.type === 'ending');
    for (const id of endingIds) {
      const logic = story[id]?.threshold_logic;
      if (logic && evaluateThreshold(logic, state.stats)) return id;
    }
    return endingIds[0] || null;
  }

  function evaluateThreshold(expression, stats) {
    if (typeof expression !== 'string' || !expression.trim()) return false;

    let jsExpression = expression.replace(/\bAND\b/gi, '&&').replace(/\bOR\b/gi, '||').replace(/\bNOT\b/gi, '!');

    STATS.forEach((key) => {
      jsExpression = jsExpression.replace(new RegExp(`\\b${key}\\b`, 'g'), String(Number(stats[key] || 0)));
    });

    if (!/^[\d\s<>=!&|()+\-.]*$/.test(jsExpression)) return false;

    try {
      return Boolean(Function(`"use strict"; return (${jsExpression});`)());
    } catch (error) {
      console.error('Threshold evaluation failed:', expression, error);
      return false;
    }
  }

  function unlockAudio() {
    if (state.audio.unlocked) return;
    state.audio.unlocked = true;
    if (state.audio.pending) {
      const pending = state.audio.pending;
      state.audio.pending = null;
      playTrackByKey(pending);
    }
  }

  function requestAudioForScene(screenId, screen) {
    const rules = state.data.audio?.rules || {};
    let trackKey = rules.special_cases?.[screenId];

    if (!trackKey && screen.type === 'ending') trackKey = rules.ending_mapping?.[screenId];
    if (!trackKey) trackKey = rules.scene_type_mapping?.[screen.type || 'story'];

    if (!trackKey) {
      stopAudio();
      return;
    }

    if (!state.audio.unlocked) {
      state.audio.pending = trackKey;
      return;
    }

    playTrackByKey(trackKey);
  }

  function playTrackByKey(trackKey) {
    const tracks = state.data.audio?.tracks || {};
    const track = tracks[trackKey];
    if (!track) {
      stopAudio();
      return;
    }

    if (state.audio.currentKey === trackKey && state.audio.currentEl) return;

    const transitionId = ++state.audio.transitionId;

    fadeOutCurrentTrack()
      .then(() => {
        if (transitionId !== state.audio.transitionId) return;

        const audio = new Audio(track.file);
        audio.loop = Boolean(track.loop);
        audio.volume = 0;

        return audio.play().then(() => {
          if (transitionId !== state.audio.transitionId) {
            audio.pause();
            return;
          }

          state.audio.currentKey = trackKey;
          state.audio.currentEl = audio;
          fadeInTrack(audio, state.audio.targetVolume, state.audio.fadeDurationMs);
        });
      })
      .catch((err) => console.warn('Audio playback failed:', err?.message || err));
  }

  function clearFadeInterval() {
    if (!state.audio.fadeIntervalId) return;
    clearInterval(state.audio.fadeIntervalId);
    state.audio.fadeIntervalId = null;
  }

  function fadeOutCurrentTrack() {
    const audio = state.audio.currentEl;
    if (!audio) return Promise.resolve();

    clearFadeInterval();

    const duration = state.audio.fadeDurationMs;
    const frameMs = 40;
    const steps = Math.max(1, Math.round(duration / frameMs));
    const startVolume = Number(audio.volume) || 0;
    let step = 0;

    return new Promise((resolve) => {
      state.audio.fadeIntervalId = setInterval(() => {
        step += 1;
        const progress = Math.min(1, step / steps);
        audio.volume = Math.max(0, startVolume * (1 - progress));

        if (progress >= 1) {
          clearFadeInterval();
          audio.pause();
          audio.currentTime = 0;
          state.audio.currentEl = null;
          state.audio.currentKey = null;
          resolve();
        }
      }, frameMs);
    });
  }

  function fadeInTrack(audio, targetVolume, durationMs) {
    if (!audio) return;

    clearFadeInterval();

    const frameMs = 40;
    const steps = Math.max(1, Math.round(durationMs / frameMs));
    let step = 0;

    audio.volume = 0;

    state.audio.fadeIntervalId = setInterval(() => {
      step += 1;
      const progress = Math.min(1, step / steps);
      audio.volume = Math.min(targetVolume, targetVolume * progress);

      if (progress >= 1) {
        audio.volume = targetVolume;
        clearFadeInterval();
      }
    }, frameMs);
  }

  function stopAudio() {
    state.audio.transitionId += 1;
    clearFadeInterval();
    if (!state.audio.currentEl) return;
    state.audio.currentEl.pause();
    state.audio.currentEl.currentTime = 0;
    state.audio.currentEl = null;
    state.audio.currentKey = null;
  }

  function extractUiContentById(elements, id) {
    if (!Array.isArray(elements)) return '';
    return elements.find((entry) => entry?.id === id)?.content || '';
  }

  function clearChoices() {
    el.choices.innerHTML = '';
  }

  function addButton(label, onClick, isContinue = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `choice-btn${isContinue ? ' continue' : ''}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    el.choices.appendChild(button);
  }

  function showError(message) {
    el.error.textContent = message;
    el.error.classList.remove('hidden');
  }

  function hideError() {
    el.error.classList.add('hidden');
    el.error.textContent = '';
  }
})();
