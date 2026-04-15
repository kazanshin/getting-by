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

  const state = {
    phase: 'boot', // boot | welcome | instructions | game | ending
    currentScreenId: null,
    instructionIndex: 0,
    stats: Object.fromEntries(STATS.map((key) => [key, 0])),
    data: {},
    audio: {
      currentKey: null,
      currentEl: null
    }
  };

  const el = {
    bg: document.getElementById('background'),
    title: document.getElementById('title'),
    text: document.getElementById('text'),
    choices: document.getElementById('choices'),
    error: document.getElementById('error'),
    dialogue: document.getElementById('dialogue')
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
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${path}`);
      }
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
      // Fallback for minor malformed JSON that should not crash the game.
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
    const welcome = state.data.ui?.welcome || {};
    setBackground(welcome.background);
    el.title.textContent = extractUiContentById(welcome.ui_elements, 'title') || 'Getting By';
    el.text.textContent = [
      extractUiContentById(welcome.ui_elements, 'subtitle'),
      '',
      extractUiContentById(welcome.ui_elements, 'start_prompt')
    ]
      .filter(Boolean)
      .join('\n');

    clearChoices();
    bindOneTimeAdvance(() => showInstructions());
    playAudioForScene('S01', { type: 'story' });
  }

  function showInstructions() {
    state.phase = 'instructions';
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
    const uiInstructionConfig = state.data.ui?.instructions_screen || {};
    setBackground(uiInstructionConfig.background || '#000000');
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
    state.stats = Object.fromEntries(STATS.map((key) => [key, 0]));
    const firstId = resolveFirstStoryId();
    goToScreen(firstId);
  }

  function resolveFirstStoryId() {
    const story = state.data.story || {};
    if (story.S01) return 'S01';

    const storyIds = Object.keys(story).filter((id) => /^S\d+/i.test(id));
    storyIds.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return storyIds[0] || null;
  }

  function goToScreen(screenId) {
    if (!screenId) {
      showError('No valid screen found.');
      return;
    }

    if (screenId === 'ENDING_CHECK') {
      const endingId = evaluateEnding();
      goToScreen(endingId);
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
    const background = resolveBackgroundForScreen(screenId, screen);
    setBackground(background);

    el.title.textContent = screen.title || '';
    el.text.textContent = screen.text || '';
    clearChoices();

    playAudioForScene(screenId, screen);

    if (screenType === 'dilemma') {
      const choices = Array.isArray(screen.choices) ? screen.choices.slice(0, 2) : [];
      if (choices.length !== 2) {
        showError(`Dilemma ${screenId} does not contain exactly 2 choices.`);
      }

      choices.forEach((choice) => {
        addButton(choice?.text || 'Choose', () => {
          applyEffects(choice?.effects);
          goToScreen(choice?.next);
        });
      });

      if (choices.length === 0) {
        addButton('Continue', () => goToScreen(screen.next), true);
      }
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
      if (!Number.isNaN(value)) {
        state.stats[key] += value;
      }
    });
  }

  function evaluateEnding() {
    const story = state.data.story || {};
    const endingIds = Object.keys(story).filter((id) => story[id]?.type === 'ending');

    for (const id of endingIds) {
      const logic = story[id]?.threshold_logic;
      if (!logic) continue;
      if (evaluateThreshold(logic, state.stats)) return id;
    }

    return endingIds[0] || null;
  }

  function evaluateThreshold(expression, stats) {
    if (typeof expression !== 'string' || !expression.trim()) return false;

    let jsExpression = expression
      .replace(/\bAND\b/gi, '&&')
      .replace(/\bOR\b/gi, '||')
      .replace(/\bNOT\b/gi, '!');

    STATS.forEach((key) => {
      const reg = new RegExp(`\\b${key}\\b`, 'g');
      jsExpression = jsExpression.replace(reg, String(Number(stats[key] || 0)));
    });

    if (!/^[\d\s<>=!&|()+\-.]*$/.test(jsExpression)) {
      console.warn('Unsafe threshold expression blocked:', expression);
      return false;
    }

    try {
      return Boolean(Function(`"use strict"; return (${jsExpression});`)());
    } catch (error) {
      console.error('Threshold evaluation failed:', expression, error);
      return false;
    }
  }

  function playAudioForScene(screenId, screen) {
    const audioData = state.data.audio || {};
    const rules = audioData.rules || {};
    const tracks = audioData.tracks || {};

    let trackKey = rules.special_cases?.[screenId];

    if (!trackKey && screen.type === 'ending') {
      trackKey = rules.ending_mapping?.[screenId];
    }

    if (!trackKey) {
      trackKey = rules.scene_type_mapping?.[screen.type || 'story'];
    }

    if (!trackKey || !tracks[trackKey]) {
      stopAudio();
      return;
    }

    if (state.audio.currentKey === trackKey && state.audio.currentEl) return;

    stopAudio();

    const track = tracks[trackKey];
    const audio = new Audio(track.file);
    audio.loop = Boolean(track.loop);
    audio.volume = 0.7;

    audio
      .play()
      .catch((err) => console.warn('Audio playback blocked until interaction:', err?.message || err));

    state.audio.currentKey = trackKey;
    state.audio.currentEl = audio;
  }

  function stopAudio() {
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

  function bindOneTimeAdvance(handler) {
    const onAdvance = () => {
      window.removeEventListener('keydown', onAdvance);
      window.removeEventListener('click', onAdvance);
      handler();
    };

    window.addEventListener('keydown', onAdvance, { once: true });
    window.addEventListener('click', onAdvance, { once: true });
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
