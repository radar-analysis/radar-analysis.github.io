/* ─── Config ─────────────────────────────────────────────────── */
const SERVER_URL = 'https://jensen-gao1999--radar-backend-web.modal.run';
const RADAR_TOKEN = 'xA9jf5RWd9';   // set to your token when pointing at the deployed backend
const K = 15;

/* ─── Gemini Schema ──────────────────────────────────────────── */
const AXIS_SCHEMA = {
  type: 'object',
  properties: {
    description:     { type: 'string' },
    in_distribution: { type: 'boolean' },
  },
  required: ['description', 'in_distribution'],
};

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    eval_obj_detects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          bbox:  { type: 'array', items: { type: 'integer' } },
        },
        required: ['label', 'bbox'],
      },
    },
    train_obj_detects: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          train_task_id: { type: 'integer' },
          obj_detects: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                bbox:  { type: 'array', items: { type: 'integer' } },
              },
              required: ['label', 'bbox'],
            },
          },
        },
        required: ['train_task_id', 'obj_detects'],
      },
    },
    train_task_analyses: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          train_task_id:        { type: 'integer' },
          image_augmentations:  AXIS_SCHEMA,
          visual_task_object:   AXIS_SCHEMA,
          visual_scene:         AXIS_SCHEMA,
          object_poses:         AXIS_SCHEMA,
          morphed_objects:      AXIS_SCHEMA,
          new_object:           AXIS_SCHEMA,
          interacting_scene:    AXIS_SCHEMA,
          other:                AXIS_SCHEMA,
          generalization: { type: 'string', enum: ['in-distribution', 'visual', 'behavioral'] },
        },
        required: ['train_task_id', 'image_augmentations', 'visual_task_object', 'visual_scene',
                   'object_poses', 'morphed_objects', 'new_object', 'interacting_scene', 'other',
                   'generalization'],
      },
    },
  },
  required: ['eval_obj_detects', 'train_obj_detects', 'train_task_analyses'],
};

/* ─── State ──────────────────────────────────────────────────── */
const state = {
  mode: 'examples',          // 'examples' | 'upload'
  queryImageDataUrl: null,   // data URL of selected/uploaded image
  queryInstruction: '',
  selectedExampleId: null,
  retrievalResults: [],
  analysisData: null,
  precomputed: {},           // id -> { retrieval, analysis }
};

/* ─── DOM refs ───────────────────────────────────────────────── */
const $ = id => document.getElementById(id);

/* ─── Init ───────────────────────────────────────────────────── */
function init() {
  // Restore saved settings
  $('gemini-key').value = localStorage.getItem('radarGeminiKey') || '';
  $('gemini-model').value = localStorage.getItem('radarGeminiModel') || 'gemini-3.1-pro-preview';

  // Persist settings on change
  $('gemini-key').addEventListener('change', () => {
    localStorage.setItem('radarGeminiKey', $('gemini-key').value.trim());
    updateAnalyzeBtn();
  });
  $('gemini-model').addEventListener('change', () => {
    localStorage.setItem('radarGeminiModel', $('gemini-model').value);
  });

  // Tabs
  document.querySelectorAll('.demo-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Upload area
  const uploadArea = $('upload-area');
  const fileInput = $('file-input');

  uploadArea.addEventListener('click', e => {
    if (!e.target.closest('.upload-actions')) fileInput.click();
  });
  uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadUploadedFile(file);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) loadUploadedFile(fileInput.files[0]);
  });
  $('clear-upload').addEventListener('click', e => {
    e.stopPropagation();
    clearUpload();
  });

  // Instruction input
  $('instruction-input').addEventListener('input', e => {
    state.queryInstruction = e.target.value.trim();
    updateRetrieveBtn();
  });

  // Retrieve & Analyze
  $('retrieve-btn').addEventListener('click', handleRetrieve);
  $('analyze-btn').addEventListener('click', handleAnalyze);

  // Load precomputed results, then examples
  tryLoadPrecomputed().then(() => tryLoadExamples());
  pollModelStatus();

  updateRetrieveBtn();
  updateAnalyzeBtn();
}

/* ─── Model status ───────────────────────────────────────────── */
async function pollModelStatus() {
  const dot  = $('model-status-dot');
  const text = $('model-status-text');

  const check = async () => {
    try {
      const headers = RADAR_TOKEN ? { 'Authorization': `Bearer ${RADAR_TOKEN}` } : {};
      const resp = await fetch(`${SERVER_URL}/health`, { headers });
      if (!resp.ok) return false;
      const data = await resp.json();
      if (data.model_loaded) {
        dot.style.background  = '#22c55e';
        text.textContent = 'Embedding model ready';
        return true;
      }
    } catch (e) { console.warn('Health check failed:', e); }
    return false;
  };

  if (await check()) return;

  const interval = setInterval(async () => {
    if (await check()) clearInterval(interval);
  }, 5000);
}

/* ─── Tabs ───────────────────────────────────────────────────── */
function switchTab(tab) {
  state.mode = tab;
  document.querySelectorAll('.demo-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.demo-tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tab}`));
  $('model-status').style.display = tab === 'upload' ? 'flex' : 'none';

  if (tab === 'examples') {
    state.queryImageDataUrl = state.selectedExampleId ? getExampleDataUrl(state.selectedExampleId) : null;
  } else {
    state.queryImageDataUrl = $('upload-preview').src || null;
  }
  updateRetrieveBtn();
}

/* ─── Precomputed results ────────────────────────────────────── */
async function tryLoadPrecomputed() {
  if (window._PRECOMPUTED) {
    state.precomputed = window._PRECOMPUTED;
  }
}

/* ─── Examples ───────────────────────────────────────────────── */
async function tryLoadExamples() {
  const grid = $('examples-grid');

  // If precomputed data is available, build cards from it (no server needed)
  if (Object.keys(state.precomputed).length > 0) {
    const examples = Object.entries(state.precomputed).map(([id, pre]) => ({
      id,
      instruction: pre.instruction,
      image_url:   pre.query_image_url,
    }));
    renderExamples(examples);
    return;
  }

  grid.innerHTML = `<div class="examples-placeholder"><span class="spinner spinner-dark"></span><span>Loading examples…</span></div>`;

  try {
    const headers = RADAR_TOKEN ? { 'Authorization': `Bearer ${RADAR_TOKEN}` } : {};
    const resp = await fetch(`${SERVER_URL}/examples`, { headers });
    if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
    const examples = await resp.json();
    renderExamples(examples);
  } catch (err) {
    grid.innerHTML = `<div class="examples-placeholder"><span style="color:#dc2626;font-size:0.85rem">Could not load examples: ${err.message}<br><br>Try refreshing the page.</span></div>`;
  }
}

function renderExamples(examples) {
  const grid = $('examples-grid');
  if (!examples.length) {
    grid.innerHTML = `<div class="examples-placeholder"><span>No examples returned by server.</span></div>`;
    return;
  }

  grid.innerHTML = examples.map(ex => {
    const label = ex.instruction || 'Do something';
    return `
    <div class="example-card" data-id="${ex.id}" data-instruction="${escHtml(label)}" data-src="${escHtml(ex.image_url)}">
      <img src="${escHtml(ex.image_url)}" alt="${escHtml(label)}" loading="lazy">
      <div class="example-card-label">${escHtml(label)}</div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.example-card').forEach(card => {
    card.addEventListener('click', () => selectExample(card));
  });
}

function selectExample(card) {
  document.querySelectorAll('.example-card').forEach(c => c.classList.remove('selected'));
  card.classList.add('selected');
  state.selectedExampleId = card.dataset.id;
  state.queryInstruction = card.dataset.instruction;
  $('instruction-input').value = state.queryInstruction;

  // Load as data URL for Gemini (handles CORS gracefully)
  fetchAsDataUrl(card.dataset.src).then(dataUrl => {
    state.queryImageDataUrl = dataUrl;
    updateRetrieveBtn();
    updateAnalyzeBtn();
  });

  clearResults();
  clearAnalysis();

  updateRetrieveBtn();
  updateAnalyzeBtn();
}

function getExampleDataUrl(id) {
  const card = document.querySelector(`.example-card[data-id="${id}"]`);
  return card ? card.dataset.src : null;
}

/* ─── Upload ─────────────────────────────────────────────────── */
function loadUploadedFile(file) {
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    const preview = $('upload-preview');
    preview.src = dataUrl;
    preview.style.display = 'block';
    $('upload-placeholder').style.display = 'none';
    $('upload-actions').style.display = 'flex';
    state.queryImageDataUrl = dataUrl;
    updateRetrieveBtn();
    updateAnalyzeBtn();
  };
  reader.readAsDataURL(file);
}

function clearUpload() {
  $('upload-preview').src = '';
  $('upload-preview').style.display = 'none';
  $('upload-placeholder').style.display = 'flex';
  $('upload-actions').style.display = 'none';
  $('file-input').value = '';
  state.queryImageDataUrl = null;
  updateRetrieveBtn();
  updateAnalyzeBtn();
}

/* ─── Retrieve ───────────────────────────────────────────────── */
function updateRetrieveBtn() {
  const btn = $('retrieve-btn');
  const hasQuery = state.queryImageDataUrl && state.queryInstruction;
  btn.disabled = !hasQuery;
  btn.title = !hasQuery ? 'Select or upload an image and enter an instruction' : '';
}

function getPrecomputed() {
  return state.mode === 'examples' && state.selectedExampleId
    ? state.precomputed[state.selectedExampleId] || null
    : null;
}

async function handleRetrieve() {
  const btn = $('retrieve-btn');

  // Use precomputed retrieval if available for this example
  const pre = getPrecomputed();
  if (pre?.retrieval) {
    clearResults();
    clearAnalysis();
    state.retrievalResults = pre.retrieval;
    renderResults(pre.retrieval);
    return;
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Retrieving…';

  clearResults();
  clearAnalysis();

  const warmupTimer = setTimeout(() => {
    showStatus('retrieve-status', 'info', 'Embedding inference is running — this can take a few minutes on first request.');
  }, 4000);

  try {
    // Extract base64 payload (strip data URL prefix)
    const base64 = state.queryImageDataUrl.includes(',')
      ? state.queryImageDataUrl.split(',')[1]
      : state.queryImageDataUrl;

    const resp = await fetch(`${SERVER_URL}/retrieve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(RADAR_TOKEN ? { 'Authorization': `Bearer ${RADAR_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        image: base64,
        instruction: state.queryInstruction,
        k: K,
      }),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Server error ${resp.status}: ${text.slice(0, 200)}`);
    }

    const data = await resp.json();
    state.retrievalResults = data.results;
    renderResults(data.results, data.mock);
  } catch (err) {
    showStatus('retrieve-status', 'error', `Retrieval failed: ${err.message}`);
  } finally {
    clearTimeout(warmupTimer);
    btn.disabled = false;
    btn.innerHTML = 'Retrieve';
    updateRetrieveBtn();
  }
}

function renderResults(results, isMock = false) {
  const section = $('results-section');
  const grid = $('results-grid');
  section.classList.remove('hidden');

  $('results-count').innerHTML = isMock
    ? `${results.length} results <span class="badge badge-visual" style="margin-left:6px">mock mode — random results</span>`
    : `${results.length} results`;

  grid.innerHTML = results.map((r, i) => `
    <div class="result-card">
      <img src="${escHtml(r.image_url)}" alt="${escHtml(r.instruction)}" loading="lazy">
      <div class="result-card-body">
        <div class="result-card-instruction">${escHtml(r.instruction)}</div>
        ${r.distance != null ? `<div class="result-card-meta">Distance: ${r.distance.toFixed(4)}</div>` : ''}
      </div>
    </div>
  `).join('');

  updateAnalyzeBtn();
}

function clearResults() {
  $('results-section').classList.add('hidden');
  $('results-grid').innerHTML = '';
  $('retrieve-status').innerHTML = '';
  state.retrievalResults = [];
}

/* ─── Analyze ────────────────────────────────────────────────── */
function updateAnalyzeBtn() {
  const btn = $('analyze-btn');
  const hasResults = state.retrievalResults.length > 0;
  const hasPrecomputed = !!(getPrecomputed()?.analysis);
  const hasKey = !!$('gemini-key').value.trim();
  btn.disabled = !hasResults || (!hasKey && !hasPrecomputed);
  btn.title = !hasResults ? 'Run retrieval first' : (!hasKey && !hasPrecomputed) ? 'Enter a Gemini API key' : '';
}

async function handleAnalyze() {
  const btn = $('analyze-btn');

  // Use precomputed analysis if available for this example
  const pre = getPrecomputed();
  if (pre?.analysis) {
    clearAnalysis();
    state.analysisData = pre.analysis;
    renderAnalysis(pre.analysis, state.retrievalResults);
    return;
  }

  const apiKey = $('gemini-key').value.trim();
  const model = $('gemini-model').value;

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing…';
  clearAnalysis();
  showStatus('analyze-status', 'info', 'Calling Gemini API — this may take a few minutes depending on the model.');

  try {
    // Convert all images to base64 for Gemini inline_data
    const queryB64 = await toGeminiImage(state.queryImageDataUrl);
    const resultImages = await Promise.all(
      state.retrievalResults.map(r => toGeminiImage(r.image_url).catch(() => null))
    );

    const parts = buildGeminiParts(queryB64, state.queryInstruction, state.retrievalResults, resultImages);
    const responseText = await callGemini(apiKey, model, parts);
    const parsed = extractJson(responseText);

    state.analysisData = parsed;
    renderAnalysis(parsed, state.retrievalResults);
  } catch (err) {
    showStatus('analyze-status', 'error', `Analysis failed: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = 'Run RADAR Analysis';
    updateAnalyzeBtn();
  }
}

function buildGeminiParts(queryImg, queryInstruction, results, resultImages) {
  const parts = [];

  const initPrompt =
`A robot is given a task, which consists of a physical scene it interacts with, and a language instruction that specifies what behavior the robot needs to perform. \
To perform the task, the robot must predict actions to execute given image observations of its scene and the language instruction. \
The robot may encounter tasks that represent generalization from the tasks in its training data. \
Tasks can require visual generalization, which means the robot does not need to generalize to new physical motion, but must be robust to visual perturbations. \
An example of this is performing a task present in the training data, but with unseen lighting conditions that affect the robot's visual observations.
Tasks can also require behavioral generalization, which means the robot must execute new physical motion that is unseen in its training data. \
An example of this is grasping an object with unseen geometry that requires a new grasp motion.

To help categorize what kind of generalization a task represents, consider the following axes that tasks can differ, grouped based on whether they involve visual or behavioral generalization:
**Visual**
- Image Augmentations: Changes to the scene image observation that does not affect the physical composition of the scene (e.g., scene lighting, image blur). \
Pay attention to any such visual changes in the image observations.
- Visual Task Object: Changes to the appearance (e.g., color, visual texture, transparency) of objects that are involved in the task (e.g., an object to be grasped, a container an object is to be put in). \
This does not include aspects of objects that also affect their physical configuration (e.g., pose, geometry).
- Visual Scene: Changes to visual elements of the scene besides objects involved in the task (e.g., the color of a tabletop surface, distractor objects that do not affect the required task behavior).
**Behavioral**
- Object Poses: Changes to the pose (position and orientation) of objects involved in the task that affect the required task behavior.
- Morphed Objects: Changes to the geometry (size and shape) of objects involved in the task that affect the required task behavior. \
This does not include changes to the type of an object (e.g., this includes changing the shape of a cup, but not changing the cup to a bottle).
- New Object: Changes to objects involved in the task to entirely new types of objects with different appearances and physical characteristics, such as geometry, that affect the required task behavior.
- Interacting Scene: Changes to other physical components of the scene besides objects involved in the task that affect the required task behavior (e.g., tabletop surface height, object clutter that blocks objects involved in the task). \
This only includes changes that affect the required task behavior (e.g., object clutter is only included if the change forces the robot to perform different behavior, such as to avoid the objects).

The robot is trained on data for the following tasks, each represented by its language instruction and initial scene image observation:`;

  parts.push({ text: initPrompt });

  results.forEach((r, i) => {
    parts.push({ text: `\n\nTask ID: ${i + 1}\nInstruction: ${r.instruction}\nScene Image: ` });
    if (resultImages[i]) parts.push(resultImages[i]);
    else parts.push({ text: '[image unavailable]' });
  });

  parts.push({ text: `\n\nAfter being trained on data for these tasks, the robot is asked to perform the following evaluation task:\nInstruction: ${queryInstruction}\nScene Image: ` });
  if (queryImg) parts.push(queryImg);

  const instructionPrompt =
`\n\nYour goal is to analyze how the evaluation task represents generalization from the training tasks. \
First, detect all objects in the evaluation task scene, providing a label and bounding box (formatted as [y_min, x_min, y_max, x_max], with coordinates normalized between 0-1000) for each object. \
Also, for each of the training tasks, detect all objects in the same format. \
Next, for each of the training tasks, provide its Task ID, and then a qualitative description of how the evaluation task and that training task differ for each axis, \
and whether or not the evaluation task is in-distribution with respect to the training task for that axis (True or False). \
If there is a difference between the tasks for that axis, then it is not in-distribution. \
Also do this for an "Other" axis that captures any other ways the tasks can differ that are not covered by the other axes. \
Use the object detections to help reason about these differences. \
When analyzing behavioral axes, pay especially close attention to any differences, even minor ones, that can affect the actions needed to perform the task. \
Consider estimating the surface area of objects involved in the task to help with analyzing behavioral axes. \
Also, pay attention to the language instruction for each task when making comparisons, as the instruction can change what objects are involved in each task \
(e.g., the same object can appear in different tasks, but may only be involved in one depending on the instruction). \
Then, use this to categorize the evaluation task as either in-distribution, visual generalization, or behavioral generalization for the training task. \
If any behavioral axis is not in-distribution, then the task is behavioral generalization, even if a visual axis is also not in-distribution. \
If the only axes that are not in-distribution are visual, then the task is visual generalization. \
If all axes are in-distribution, then the task is in-distribution. \
IMPORTANT: Make sure to provide an analysis for every training task, do not skip any. Provide your response in JSON format.`;

  parts.push({ text: instructionPrompt });
  return parts;
}

async function callGemini(apiKey, model, parts) {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0,
        },
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini API error ${resp.status}`);
  }

  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function extractJson(text) {
  // Strip markdown fences if present
  const cleaned = text.replace(/^```json?\n?/i, '').replace(/\n?```$/i, '').trim();
  return JSON.parse(cleaned);
}

/* ─── Render Analysis ────────────────────────────────────────── */
const AXIS_LABELS = {
  image_augmentations: 'Image Augmentations',
  visual_task_object:  'Visual Task Object',
  visual_scene:        'Visual Scene',
  object_poses:        'Object Poses',
  morphed_objects:     'Morphed Objects',
  new_object:          'New Object',
  interacting_scene:   'Interacting Scene',
  other:               'Other',
};

const CLASS_CONFIG = {
  'in-distribution': { icon: '✓', cssClass: 'indist',     badge: 'badge-indist',    label: 'In-Distribution' },
  'visual':          { icon: '',   cssClass: 'visual',     badge: 'badge-visual',    label: 'Visual Generalization' },
  'behavioral':      { icon: '↗', cssClass: 'behavioral', badge: 'badge-behavioral', label: 'Behavioral Generalization' },
};

const VISUAL_AXES     = ['image_augmentations', 'visual_task_object', 'visual_scene'];
const BEHAVIORAL_AXES = ['object_poses', 'morphed_objects', 'new_object', 'interacting_scene'];

function classifyFromAxes(analysis) {
  const behavioralOOD = BEHAVIORAL_AXES.some(k => analysis[k] && !analysis[k].in_distribution);
  if (behavioralOOD) return 'behavioral';
  const visualOOD = VISUAL_AXES.some(k => analysis[k] && !analysis[k].in_distribution);
  if (visualOOD) return 'visual';
  return 'in-distribution';
}

function computeOverallClassification(analyses) {
  const gens = analyses.map(classifyFromAxes);
  if (gens.includes('in-distribution')) return 'in-distribution';
  if (gens.includes('visual')) return 'visual';
  return 'behavioral';
}

function renderAnalysis(data, results) {
  const section = $('analysis-section');
  section.classList.remove('hidden');

  const analyses = data.train_task_analyses || [];

  // Compute overall classification by aggregation
  const overallClass = computeOverallClassification(analyses);
  const cfg = CLASS_CONFIG[overallClass] || { icon: '?', cssClass: '', label: overallClass };

  const counts = { 'in-distribution': 0, 'visual': 0, 'behavioral': 0 };
  analyses.forEach(a => { const c = classifyFromAxes(a); if (c in counts) counts[c]++; });
  const countParts = [];
  if (counts['in-distribution'] > 0) countParts.push(`${counts['in-distribution']} in-distribution`);
  if (counts['visual'] > 0) countParts.push(`${counts['visual']} visual`);
  if (counts['behavioral'] > 0) countParts.push(`${counts['behavioral']} behavioral`);
  const overallReasoning = `Of ${analyses.length} retrieved examples: ${countParts.join(', ')}.`;

  $('overall-verdict').innerHTML = `
    <div class="overall-verdict">
      <div class="verdict-icon">${cfg.icon}</div>
      <div>
        <div class="verdict-label">Overall Classification</div>
        <div class="verdict-classification ${cfg.cssClass}">${cfg.label}</div>
        <div class="verdict-reasoning">${escHtml(overallReasoning)}</div>
      </div>
    </div>`;

  // Per-example cards

  const container = $('analysis-examples');
  container.innerHTML = analyses.map((ex, i) => {
    const result = results[i] || {};
    const exCfg = CLASS_CONFIG[classifyFromAxes(ex)] || { badge: '', label: '' };

    const axesRows = Object.entries(AXIS_LABELS).map(([key, label]) => {
      const axis = ex[key];
      if (!axis) return '';
      const indist = axis.in_distribution;
      return `
        <tr>
          <td class="left">${label}</td>
          <td class="${indist ? 'axis-indist' : 'axis-ood'}">${indist ? 'In-Dist' : 'OOD'}</td>
          <td class="left" style="color:var(--text-secondary)">${escHtml(axis.description || '')}</td>
        </tr>`;
    }).join('');

    return `
      <div class="analysis-card" id="analysis-card-${i}">
        <div class="analysis-card-header" onclick="toggleAnalysisCard(${i})">
          ${result.image_url ? `<img class="analysis-card-thumb" src="${escHtml(result.image_url)}" alt="">` : ''}
          <span class="analysis-card-instruction">${escHtml(result.instruction || `Example ${i + 1}`)}</span>
          <span class="badge ${exCfg.badge}">${exCfg.label}</span>
          <span class="analysis-card-toggle">▼</span>
        </div>
        <div class="analysis-card-body">
          <table class="axes-table">
            <thead><tr><th class="left">Axis</th><th>Status</th><th class="left">Description</th></tr></thead>
            <tbody>${axesRows}</tbody>
          </table>
        </div>
      </div>`;
  }).join('');
}

function toggleAnalysisCard(i) {
  const card = $(`analysis-card-${i}`);
  card.classList.toggle('open');
}

function clearAnalysis() {
  $('analysis-section').classList.add('hidden');
  $('overall-verdict').innerHTML = '';
  $('analysis-examples').innerHTML = '';
  $('analyze-status').innerHTML = '';
  state.analysisData = null;
}

/* ─── Helpers ────────────────────────────────────────────────── */
async function toGeminiImage(src) {
  if (!src) return null;
  let dataUrl = src;
  if (!src.startsWith('data:')) {
    dataUrl = await fetchAsDataUrl(src);
  }
  const [header, b64] = dataUrl.split(',');
  const mimeType = header.match(/:(.*?);/)[1];
  return { inline_data: { mime_type: mimeType, data: b64 } };
}

async function fetchAsDataUrl(url) {
  const resp = await fetch(url);
  const blob = await resp.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function showStatus(containerId, type, msg) {
  $(containerId).innerHTML = `<div class="status-msg status-${type}">${escHtml(msg)}</div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ─── Boot ───────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', init);
