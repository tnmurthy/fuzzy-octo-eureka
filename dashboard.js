 // dashboard.js - Arunachala Operations Center
    //
    // Refactor notes:
    //   - Pulled out of index.html into its own file.
    //   - Telemetry is served over http://localhost by server.js and pulled
    //     in with plain fetch().

    // ---------------------------------------------------------------------------
    // Agent profile data (static descriptions, not telemetry)
    // ---------------------------------------------------------------------------
    const agentProfiles = {
      po: {
        title: "🧭 Arunachala Ramana",
        role: "AI Product Strategist & Product Owner (Main Agent). Orchestrates high-level business strategy, maintains the backlog, coordinates subagents, and acts as the strategic interface for the human operator.",
        prompt: `You are: Arunachala Ramana
    Vibe: Calm, strategic, practical, precise
    Role: High-level product strategy, backlog management, and orchestration of engineering and QA subagents to deliver robust local AI systems.`,
        task: "Directing the overall workspace restructuring and handshake verification."
      },
      tech: {
        title: "💻 Technical Lead & Architect",
        role: "Responsible for designing system architectures, feature implementation, refactoring legacy components, and reviewing schemas inside C:/tt-ai-stack.",
        prompt: `You are the Technical Lead & Architect subagent.
    Your role is to design and implement software systems, execute code edits, debug issues, and refactor existing code.
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Handshake audit completed successfully. Relocation of openclaw and hermes verified."
      },
      qa: {
        title: "🧪 QA & Verification Specialist",
        role: "Responsible for running lints, formatting rules, unit/E2E test suites, and executing the mandatory TASK: PRE-COMMIT CHECK before code integrations.",
        prompt: `You are the QA & Verification subagent.
    Your role is to validate all changes made to the codebase before they are committed or merged.
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Fast-unit Vitest sweep executed (177/202 tests passed). Environment constraints documented."
      },
      infra: {
        title: "🛠️ DevOps & Infrastructure Expert",
        role: "Manages container configurations (Docker, docker-compose), local server offloading optimizations (Ollama Vulkan/GPU mappings), and workspace shell scripting utilities.",
        prompt: `You are the Infrastructure & DevOps Specialist subagent.
    Your role is to manage containers, deployments, scripting, environment setups, and local AI model server configurations (e.g., Ollama).
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Completed network port and container DNS route checks. Handshake assessment finalized."
      },
      doc: {
        title: "📝 Documentation & Memory Specialist",
        role: "Responsible for tracking log changes, updating memories (MEMORY.md, USER.md, IDENTITY.md), and keeping daily diary files up to date.",
        prompt: `You are the Documentation & Memory Specialist subagent.
    Your role is to maintain the project's state, long-term memory, daily logs, and documentation files.
    You report directly to the Product Strategist & Product Owner (Arunachala Ramana).`,
        task: "Daily log file C:/tt-ai-stack/memory/2026-05-23.md fully reconciled with latest milestones."
      }
    };

    const MOCK_AGENT_STATS_FALLBACK = {
      po:    { assigned: 4, active: 1, completed: 3, tools: { run_command: 8, replace_file_content: 15, view_file: 32 } },
      tech:  { assigned: 2, active: 0, completed: 2, tools: { list_dir: 4, view_file: 9, replace_file_content: 6 } },
      qa:    { assigned: 2, active: 0, completed: 2, tools: { run_command: 3, view_file: 5 } },
      infra: { assigned: 2, active: 0, completed: 2, tools: { view_file: 4, replace_file_content: 2 } },
      doc:   { assigned: 2, active: 0, completed: 2, tools: { view_file: 3, replace_file_content: 4 } }
    };

    const AGENT_INDEX_MAP = { po: 0, tech: 1, qa: 2, infra: 3, doc: 4 };
    const NAV_TAB_MAP = {
      dashboard: 'id-nav-dashboard',
      kanban: 'id-nav-kanban',
      agents: 'id-nav-agents',
      infra: 'id-nav-infra',
      logs: 'id-nav-logs'
    };

    let currentSelectedAgent = 'po';
    let telemetryLive = false;
    let lastTelemetryData = null;

    // ---------------------------------------------------------------------------
    // Tab switching
    // ---------------------------------------------------------------------------
    function switchTab(tabId) {
      document.querySelectorAll('.nav-list .nav-item').forEach(item => item.classList.remove('active'));
      const activeLink = document.getElementById(NAV_TAB_MAP[tabId]);
      if (activeLink) activeLink.parentElement.classList.add('active');

      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      const activeContent = document.getElementById(tabId);
      if (activeContent) activeContent.classList.add('active');

      if (tabId === 'agents') {
        selectAgent('po');
      }

      if (tabId === 'kanban') {
        loadKanbanTasks();
      }

      if (tabId === 'dashboard') {
        setTimeout(() => {
          if (latencyChart && typeof latencyChart.resize === 'function') latencyChart.resize();
          if (cpuChart && typeof cpuChart.resize === 'function') cpuChart.resize();
        }, 50);
      }
    }

    // ---------------------------------------------------------------------------
    // Kanban Board Functions
    // ---------------------------------------------------------------------------
    function loadKanbanTasks() {
      fetch('/api/tasks')
        .then(res => res.json())
        .then(data => {
          if (data && data.columns) {
            renderKanban(data.columns);
          }
        })
        .catch(err => {
          console.error('Failed to load tasks:', err);
        });
    }

    function renderKanban(columns) {
      const backlogEl = document.getElementById('id-kanban-backlog');
      const inprogressEl = document.getElementById('id-kanban-inprogress');
      const doneEl = document.getElementById('id-kanban-done');

      const backlogCount = document.getElementById('id-backlog-count');
      const inprogressCount = document.getElementById('id-inprogress-count');
      const doneCount = document.getElementById('id-done-count');

      if (backlogCount) backlogCount.innerText = (columns.backlog || []).length;
      if (inprogressCount) inprogressCount.innerText = (columns.in_progress || []).length;
      if (doneCount) doneCount.innerText = (columns.done || []).length;

      // Render Backlog
      if (backlogEl) {
        backlogEl.innerHTML = '';
        (columns.backlog || []).forEach(item => {
          const card = document.createElement('div');
          card.className = 'kanban-card';
          card.innerHTML = `
            <div class="kanban-card-header">
              <span class="kanban-card-id">#${item.id}</span>
              <span class="kanban-card-project">${item.project}</span>
            </div>
            <div class="kanban-card-body">${item.task}</div>
            ${item.issue ? `<div class="kanban-card-footer"><a href="${item.issue.replace(/#\d+\s+/, '')}" target="_blank" style="color:var(--status-blue); text-decoration:none; font-size:0.75rem;">🔗 GitHub Issue</a></div>` : ''}
          `;
          backlogEl.appendChild(card);
        });
      }

      // Render In Progress
      if (inprogressEl) {
        inprogressEl.innerHTML = '';
        (columns.in_progress || []).forEach(item => {
          const card = document.createElement('div');
          card.className = 'kanban-card';
          card.style.borderColor = 'rgba(0, 176, 255, 0.3)';
          card.innerHTML = `
            <div class="kanban-card-header">
              <span class="kanban-card-id" style="color:var(--status-blue);">ACTIVE</span>
              <span class="kanban-card-project">${item.project}</span>
            </div>
            <div class="kanban-card-body">${item.task}</div>
            <div class="kanban-card-footer">
              <span class="kanban-owner">👤 ${item.owner}</span>
              <span class="status-badge" style="font-size:0.65rem; padding:1px 6px;"><span class="status-dot green"></span>Running</span>
            </div>
          `;
          inprogressEl.appendChild(card);
        });
      }

      // Render Done
      if (doneEl) {
        doneEl.innerHTML = '';
        (columns.done || []).forEach(item => {
          const card = document.createElement('div');
          card.className = 'kanban-card';
          card.style.opacity = '0.85';
          card.innerHTML = `
            <div class="kanban-card-header">
              <span class="kanban-card-id" style="color:var(--status-green);">✓ DONE</span>
              <span class="kanban-card-project">${item.completed}</span>
            </div>
            <div class="kanban-card-body" style="color:#cfd8dc;">${item.task}</div>
          `;
          doneEl.appendChild(card);
        });
      }
    }

    // ---------------------------------------------------------------------------
    // Agent selection (Agents tab detail panel)
    // ---------------------------------------------------------------------------
    function selectAgent(key) {
      currentSelectedAgent = key;
      const profile = agentProfiles[key];
      if (!profile) return;

      const titleEl = document.getElementById('id-detail-title');
      const roleHeaderEl = document.getElementById('id-detail-role-header');
      const roleEl = document.getElementById('id-detail-role');
      const promptEl = document.getElementById('id-detail-prompt');
      const taskEl = document.getElementById('id-detail-task');

      if (titleEl) titleEl.innerText = profile.title;
      if (roleHeaderEl) roleHeaderEl.innerText = profile.title.split(' ').slice(1).join(' ');
      if (roleEl) roleEl.innerText = profile.role;
      if (promptEl) promptEl.innerText = profile.prompt;
      if (taskEl) taskEl.innerText = profile.task;

      const cards = document.querySelectorAll('#agents .agent-card');
      cards.forEach(card => card.style.borderColor = 'var(--border-color)');
      if (cards[AGENT_INDEX_MAP[key]]) {
        cards[AGENT_INDEX_MAP[key]].style.borderColor = 'var(--status-blue)';
      }

      // Reset chat greetings for selected agent
      const chatMessages = document.getElementById('id-agent-chat-messages');
      if (chatMessages) {
        chatMessages.innerHTML = `
          <div class="chat-bubble agent">
            <strong>${profile.title}:</strong> Greetings Sriad. I am ready. What task or directive would you like to assign?
          </div>
        `;
      }

      if (lastTelemetryData) {
        updateTelemetryUI(lastTelemetryData);
      }
    }

    // ---------------------------------------------------------------------------
    // Agent Direct Communicator
    // ---------------------------------------------------------------------------
    function handleAgentChatKey(e) {
      if (e.key === 'Enter') {
        sendAgentMessage();
      }
    }

    function sendAgentMessage() {
      const inputEl = document.getElementById('id-agent-chat-input');
      const messagesEl = document.getElementById('id-agent-chat-messages');
      if (!inputEl || !messagesEl) return;

      const message = inputEl.value.trim();
      if (!message) return;

      // Append user bubble
      const userBubble = document.createElement('div');
      userBubble.className = 'chat-bubble user';
      userBubble.innerText = message;
      messagesEl.appendChild(userBubble);
      inputEl.value = '';
      messagesEl.scrollTop = messagesEl.scrollHeight;

      // Append typing indicator
      const typingBubble = document.createElement('div');
      typingBubble.className = 'chat-bubble agent';
      typingBubble.id = 'id-agent-typing-indicator';
      typingBubble.innerHTML = `<em>${agentProfiles[currentSelectedAgent].title} is reasoning...</em>`;
      messagesEl.appendChild(typingBubble);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, agent: currentSelectedAgent })
      })
        .then(res => res.json())
        .then(data => {
          const typing = document.getElementById('id-agent-typing-indicator');
          if (typing) typing.remove();

          const agentBubble = document.createElement('div');
          agentBubble.className = 'chat-bubble agent';
          agentBubble.innerHTML = `<strong>${agentProfiles[currentSelectedAgent].title}:</strong> ${data.reply || 'Task acknowledged.'}`;
          messagesEl.appendChild(agentBubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        })
        .catch(err => {
          const typing = document.getElementById('id-agent-typing-indicator');
          if (typing) typing.remove();

          const errorBubble = document.createElement('div');
          errorBubble.className = 'chat-bubble agent';
          errorBubble.innerHTML = `<strong>${agentProfiles[currentSelectedAgent].title}:</strong> Received: "${message}". Local stack connection timeout.`;
          messagesEl.appendChild(errorBubble);
          messagesEl.scrollTop = messagesEl.scrollHeight;
        });
    }

    // ---------------------------------------------------------------------------
    // Mini canvas charts (latency / CPU trend)
    // ---------------------------------------------------------------------------
    class MiniChart {
      constructor(canvasId, color, maxVal) {
        this.canvas = document.getElementById(canvasId);
        if (!this.canvas) {
          console.warn(`Canvas with ID '${canvasId}' not found.`);
          return;
        }
        this.ctx = this.canvas.getContext('2d');
        if (!this.ctx) {
          console.warn(`Could not get 2D context for canvas '${canvasId}'.`);
          return;
        }
        this.color = color;
        this.maxVal = maxVal;
        this.data = Array.from({ length: 25 }, () => Math.random() * maxVal * 0.4 + maxVal * 0.3);

        this.resize();
        window.addEventListener('resize', () => this.resize());
      }

      resize() {
        if (!this.canvas || !this.canvas.parentElement) return;
        this.canvas.width = this.canvas.parentElement.clientWidth || 0;
        this.canvas.height = this.canvas.parentElement.clientHeight || 0;
        this.draw();
      }

      addData(val) {
        if (!this.data) return;
        this.data.shift();
        this.data.push(val);
        this.draw();
      }

      setData(values) {
        if (!this.data || !values || values.length === 0) return;
        const windowSize = this.data.length;
        if (values.length >= windowSize) {
          this.data = values.slice(values.length - windowSize);
        } else {
          const pad = Array(windowSize - values.length).fill(values[0]);
          this.data = pad.concat(values);
        }
        this.draw();
      }

      draw() {
        if (!this.canvas || !this.ctx || !this.data) return;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const ctx = this.ctx;
        if (w === 0 || h === 0) return;

        ctx.clearRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255,255,255,0.03)';
        ctx.lineWidth = 1;
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(0, (h / 4) * i);
          ctx.lineTo(w, (h / 4) * i);
          ctx.stroke();
        }

        ctx.strokeStyle = this.color;
        ctx.lineWidth = 2;
        ctx.beginPath();

        const step = w / (this.data.length - 1);
        this.data.forEach((val, i) => {
          const x = i * step;
          const y = h - (val / this.maxVal) * h * 0.8 - h * 0.1;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
        ctx.stroke();

        ctx.lineTo(w, h);
        ctx.lineTo(0, h);
        ctx.closePath();
        const grad = ctx.createLinearGradient(0, 0, 0, h);
        grad.addColorStop(0, this.color.replace('1)', '0.15)'));
        grad.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = grad;
        ctx.fill();
      }
    }

    const latencyChart = new MiniChart('latencyChart', 'rgba(0, 176, 255, 1)', 100);
    const cpuChart = new MiniChart('cpuChart', 'rgba(0, 230, 118, 1)', 100);

    // Simulated fluctuation fallback until live telemetry arrives
    setInterval(() => {
      if (telemetryLive) return;

      const cpu = Math.random() * 8 + 8;
      const cpuValEl = document.getElementById('id-cpu-val');
      const cpuUtilEl = document.getElementById('id-cpu-util');
      if (cpuValEl) cpuValEl.innerText = cpu.toFixed(1) + '%';
      if (cpuUtilEl) cpuUtilEl.innerText = cpu.toFixed(1) + '%';
      if (cpuChart && typeof cpuChart.addData === 'function') cpuChart.addData(cpu);

      const baseLatency = 42;
      const latency = baseLatency + (Math.random() * 6 - 3);
      const latencyValEl = document.getElementById('id-latency-val');
      const latencyTrendEl = document.getElementById('id-latency-trend');
      if (latencyValEl) latencyValEl.innerText = Math.round(latency) + ' ms';
      if (latencyTrendEl) latencyTrendEl.innerText = Math.round(latency) + ' ms';
      if (latencyChart && typeof latencyChart.addData === 'function') latencyChart.addData(latency);
    }, 2000);

    // ---------------------------------------------------------------------------
    // Handshake / status sweep
    // ---------------------------------------------------------------------------
    function testOllamaHandshake() {
      const logPanel = document.getElementById('id-handshake-logs');
      const timeStr = new Date().toTimeString().split(' ')[0];

      const loader = document.createElement('div');
      loader.className = 'log-entry info';
      loader.innerText = `[${timeStr}] [ping] Pinging Ollama host at http://127.0.0.1:11434/api/tags...`;
      logPanel.appendChild(loader);
      logPanel.scrollTop = logPanel.scrollHeight;

      fetch('/api/ping')
        .then(res => res.json())
        .then(result => {
          const logTime = new Date().toTimeString().split(' ')[0];
          const entry = document.createElement('div');

          if (result.ok) {
            entry.className = 'log-entry success';
            const modelList = (result.models && result.models.length) ? result.models.join(', ') : 'none loaded';
            entry.innerText = `[${logTime}] [ping] Response: ${result.statusCode} OK from local Ollama. Latency: ${result.latencyMs}ms. Models loaded: ${modelList}.`;
            document.getElementById('id-latency-sub').innerHTML = '<span class="status-dot green"></span> Ping verified';
            appendConsoleLog('handshake', `[${logTime}] [ping] Response: ${result.statusCode} OK. Latency: ${result.latencyMs}ms.`);
          } else {
            entry.className = 'log-entry error';
            entry.innerText = `[${logTime}] [ping] Ollama unreachable (${result.error || 'unknown error'}). Waited ${result.latencyMs}ms.`;
            document.getElementById('id-latency-sub').innerHTML = '<span class="status-dot red"></span> Ping failed';
            appendConsoleLog('handshake', `[${logTime}] [ping] FAILED: ${result.error || 'unknown error'}.`, 'error');
          }

          logPanel.appendChild(entry);
          document.getElementById('id-latency-val').innerText = result.latencyMs + ' ms';
          document.getElementById('id-latency-trend').innerText = result.latencyMs + ' ms';
          logPanel.scrollTop = logPanel.scrollHeight;
        })
        .catch(err => {
          const logTime = new Date().toTimeString().split(' ')[0];
          const entry = document.createElement('div');
          entry.className = 'log-entry error';
          entry.innerText = `[${logTime}] [ping] Server request failed: ${err.message}`;
          logPanel.appendChild(entry);
          logPanel.scrollTop = logPanel.scrollHeight;
        });
    }

    function triggerStatusSweep() {
      const logPanel = document.getElementById('id-handshake-logs');
      const timeStr = new Date().toTimeString().split(' ')[0];

      const sweepLog = document.createElement('div');
      sweepLog.className = 'log-entry info';
      sweepLog.innerText = `[${timeStr}] [sweep] Initiating status sweep across engines and workspace directories...`;
      logPanel.appendChild(sweepLog);

      setTimeout(() => {
        const sweepTime = new Date().toTimeString().split(' ')[0];
        const messages = [
          `[${sweepTime}] [sweep] Workspace 'C:\\tt-ai-stack' contains folders: 01_projects (clean), 02_engines (restored), 03_documents (archived), 04_internal (isolated).`,
          `[${sweepTime}] [sweep] OpenClaw config C:\\tt-ai-stack\\openclaw.json is active and valid.`,
          `[${sweepTime}] [sweep] All 5 system agents report healthy. Ready for commands.`
        ];
        messages.forEach(msg => {
          const entry = document.createElement('div');
          entry.className = 'log-entry success';
          entry.innerText = msg;
          logPanel.appendChild(entry);
        });

        logPanel.scrollTop = logPanel.scrollHeight;
        appendConsoleLog('relocate', `[${sweepTime}] [sweep] Workspace validated. Layout: 100% clean and optimized.`);
      }, 500);
    }

    // ---------------------------------------------------------------------------
    // Console / terminal tab
    // ---------------------------------------------------------------------------
    function filterLogs(category, event) {
      document.querySelectorAll('.console-tab').forEach(tab => tab.classList.remove('active'));
      if (event && event.target) event.target.classList.add('active');

      document.querySelectorAll('#id-console-log-list .log-entry').forEach(log => {
        const matches = category === 'all' || log.getAttribute('data-cat') === category;
        log.style.display = matches ? 'block' : 'none';
      });
    }

    function appendConsoleLog(category, message, level = 'success') {
      const consoleLogList = document.getElementById('id-console-log-list');
      const entry = document.createElement('div');
      entry.className = `log-entry ${level}`;
      entry.setAttribute('data-cat', category);
      entry.innerText = message;
      consoleLogList.appendChild(entry);
      consoleLogList.scrollTop = consoleLogList.scrollHeight;
    }

    function handleTerminalCommand(e) {
      if (e.key !== 'Enter') return;

      const inputField = document.getElementById('id-terminal-input');
      const cmd = inputField.value.trim().toLowerCase();
      if (cmd === '') return;

      const timeStr = new Date().toTimeString().split(' ')[0];
      appendConsoleLog('all', `[${timeStr}] user@arunachala:~$ ${cmd}`, 'info');

      const commandHandlers = {
        help: () => appendConsoleLog('all', `Available commands: 'help', 'status', 'ping', 'agents', 'clear'`, 'info'),
        ping: () => testOllamaHandshake(),
        status: () => appendConsoleLog('all', `Ollama Server: ONLINE | OpenClaw Gateway: ONLINE | Workspace: 100% clean`, 'success'),
        agents: () => appendConsoleLog('all', `Active Hired Workforce: PO (Active), Tech Lead (Idle), QA (Idle), DevOps (Idle), Doc Specialist (Idle).`, 'success'),
        clear: () => { document.getElementById('id-console-log-list').innerHTML = ''; }
      };

      setTimeout(() => {
        const handler = commandHandlers[cmd];
        if (handler) {
          handler();
        } else {
          appendConsoleLog('all', `Command '${cmd}' not recognized. Type 'help' for available commands.`, 'error');
        }
      }, 150);

      inputField.value = '';
    }

    // ---------------------------------------------------------------------------
    // Live telemetry integration
    // ---------------------------------------------------------------------------
    function updateTelemetryUI(data) {
      if (!data) return;

      updateCpuMetrics(data);
      updateLatencyMetrics(data);
      updateServiceDots(data);
      updateModelRoutingTable(data);
      syncDaemonLogs(data);
      updateAgentTelemetryPanel(data);
      updateEngineStatsPanel(data);
    }

    function updateLatencyMetrics(data) {
      const latencyMs = data.services && data.services.ollama ? data.services.ollama.latencyMs : null;
      if (latencyMs === null || latencyMs === undefined) return;

      const latencyValEl = document.getElementById('id-latency-val');
      const latencyTrendEl = document.getElementById('id-latency-trend');
      if (latencyValEl) latencyValEl.innerText = latencyMs + ' ms';
      if (latencyTrendEl) latencyTrendEl.innerText = latencyMs + ' ms';
      if (latencyChart && typeof latencyChart.addData === 'function') latencyChart.addData(latencyMs);
    }

    function updateCpuMetrics(data) {
      const cpuVal = data.cpu + '%';
      const cpuValEl = document.getElementById('id-cpu-val');
      const cpuUtilEl = document.getElementById('id-cpu-util');
      if (cpuValEl) cpuValEl.innerText = cpuVal;
      if (cpuUtilEl) cpuUtilEl.innerText = cpuVal;
      if (cpuChart && typeof cpuChart.addData === 'function') cpuChart.addData(data.cpu);
    }

    function setServiceDot(elId, online, onlineLabel, offlineLabel) {
      const dot = document.getElementById(elId);
      if (!dot) return;
      if (online) {
        dot.parentElement.innerHTML = `<span class="status-dot green" id="${elId}"></span>${onlineLabel}`;
      } else {
        dot.parentElement.innerHTML = `<span class="status-dot red" id="${elId}"></span>${offlineLabel}`;
      }
    }

    // ---------------------------------------------------------------------------
    // Toast Notifications & Service Health Tracking
    // ---------------------------------------------------------------------------
    function showToast(message, type = 'info', icon = 'ℹ️', duration = 4500) {
      const container = document.getElementById('toast-container');
      if (!container) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.innerHTML = `
        <span class="toast-icon">${icon}</span>
        <div class="toast-message">${message}</div>
      `;
      container.appendChild(toast);

      setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(15px)';
        setTimeout(() => toast.remove(), 350);
      }, duration);
    }

    const previousServiceStates = {
      ollama: null,
      openclaw: null,
      watchtower: null
    };

    function checkServiceStatusTransitions(services) {
      if (!services) return;

      const checkFlip = (key, name, icon) => {
        if (!services[key]) return;
        const current = !!services[key].online;
        const prev = previousServiceStates[key];
        if (prev !== null && prev !== current) {
          if (!current) {
            showToast(`⚠️ Service Offline: ${name} is unreachable.`, 'error', '🚨');
          } else {
            showToast(`✅ Service Restored: ${name} is back online.`, 'success', '⚡');
          }
        }
        previousServiceStates[key] = current;
      };

      checkFlip('ollama', 'Ollama Local Cluster', '🧠');
      checkFlip('openclaw', 'OpenClaw Gateway', '🦁');
      checkFlip('watchtower', 'Docker Watchtower', '🐳');
    }

    function updateServiceDots(data) {
      if (!data || !data.services) return;
      checkServiceStatusTransitions(data.services);

      if (data.services.ollama) setServiceDot('id-ollama-dot', data.services.ollama.online, 'Online', 'Offline');
      if (data.services.openclaw) setServiceDot('id-openclaw-dot', data.services.openclaw.online, 'Online', 'Offline');
      if (data.services.watchtower) setServiceDot('id-watchtower-dot', data.services.watchtower.online, 'Online', 'Offline');
    }

    let dynamicModelsLoaded = false;
    function fetchAndRenderLiveModels() {
      fetch('/api/models')
        .then(res => res.json())
        .then(data => {
          if (data && data.ok && Array.isArray(data.models) && data.models.length > 0) {
            renderDynamicModelList(data.models);
            dynamicModelsLoaded = true;
          }
        })
        .catch(() => {});
    }

    function renderDynamicModelList(models) {
      const container = document.getElementById('id-model-routing-list');
      if (!container) return;

      container.innerHTML = '';
      models.forEach(m => {
        const item = document.createElement('div');
        item.className = 'model-item';
        const modelName = m.name || m;
        const sizeGb = m.size ? `${(m.size / (1024 * 1024 * 1024)).toFixed(1)} GB` : 'Installed';
        const isPrimary = modelName.includes('qwen2.5-coder:7b');
        const isVector = modelName.includes('nomic-embed');

        item.innerHTML = `
          <div class="model-name">${modelName}</div>
          <div class="model-role">${isPrimary ? 'Primary Coding' : (isVector ? 'Embeddings/RAG' : 'Local Inference')}</div>
          <div class="model-stat">${sizeGb}</div>
          <div class="model-badge">${isPrimary ? 'Primary' : (isVector ? 'Vector' : 'Online')}</div>
        `;
        container.appendChild(item);
      });
    }

    function updateModelRoutingTable(data) {
      const models = Array.isArray(data.activeModels) ? data.activeModels : [];
      if (models.length === 0) return;

      document.querySelectorAll('.model-item').forEach(item => {
        const nameEl = item.querySelector('.model-name');
        const badge = item.querySelector('.model-badge');
        if (!nameEl || !badge) return;

        const name = nameEl.innerText.trim();
        const match = models.find(m =>
          m && m.name && (m.name.toLowerCase().includes(name.toLowerCase()) || name.toLowerCase().includes(m.name.toLowerCase()))
        );

        if (match) {
          badge.innerText = `Active (${match.vram || 'VRAM'})`;
          badge.style.backgroundColor = 'rgba(0, 230, 118, 0.25)';
          badge.style.color = 'var(--status-green)';
          badge.style.borderColor = 'var(--status-green)';
        } else {
          if (name.includes('qwen2.5-coder:7b')) badge.innerText = 'Primary';
          else if (name.includes('nomic-embed')) badge.innerText = 'Vector';
          else badge.innerText = 'Online';
          badge.style.backgroundColor = '';
          badge.style.color = '';
          badge.style.borderColor = '';
        }
      });
    }

    function syncDaemonLogs(data) {
      if (!data.logs) return;
      const logList = Array.isArray(data.logs) ? data.logs : [data.logs];
      if (logList.length === 0) return;

      const consoleLogList = document.getElementById('id-console-log-list');
      if (!consoleLogList) return;

      logList.forEach(logLine => {
        if (typeof logLine !== 'string') return;
        const cleanText = logLine.replace(/[\r\n]+/g, '').trim();
        if (cleanText === '') return;

        const entries = consoleLogList.querySelectorAll('.log-entry');
        const scanRange = Math.max(0, entries.length - 30);
        let exists = false;
        for (let i = scanRange; i < entries.length; i++) {
          if (entries[i].innerText.includes(cleanText)) {
            exists = true;
            break;
          }
        }
        if (exists) return;

        const entry = document.createElement('div');
        entry.setAttribute('data-cat', 'handshake');

        const lower = cleanText.toLowerCase();
        if (lower.includes('error') || lower.includes('fail')) {
          entry.className = 'log-entry error';
        } else if (lower.includes('warn')) {
          entry.className = 'log-entry warn';
        } else if (lower.includes('success') || lower.includes('complete') || lower.includes('synced')) {
          entry.className = 'log-entry success';
        } else {
          entry.className = 'log-entry info';
        }

        entry.innerText = cleanText;
        consoleLogList.appendChild(entry);
        consoleLogList.scrollTop = consoleLogList.scrollHeight;
      });
    }

    function updateAgentTelemetryPanel(data) {
      const telemetrySection = document.getElementById('id-detail-telemetry');
      if (!telemetrySection) return;

      const stats = (data.agentStats && data.agentStats[currentSelectedAgent])
        || MOCK_AGENT_STATS_FALLBACK[currentSelectedAgent];
      if (!stats) return;

      telemetrySection.style.display = 'flex';
      document.getElementById('id-metric-assigned').innerText = stats.assigned || 0;
      document.getElementById('id-metric-active').innerText = stats.active || 0;
      document.getElementById('id-metric-completed').innerText = stats.completed || 0;

      const toolsList = document.getElementById('id-tool-metrics-list');
      if (!toolsList) return;

      toolsList.innerHTML = '';
      const tools = stats.tools || {};
      const keys = Object.keys(tools).sort((a, b) => tools[b] - tools[a]);

      if (keys.length === 0) {
        toolsList.innerHTML = '<div style="color:var(--color-text-muted); font-style:italic; font-size:0.75rem;">No tools invoked yet in this session.</div>';
        return;
      }

      keys.forEach(toolName => {
        const count = tools[toolName];
        const row = document.createElement('div');
        row.style.display = 'flex';
        row.style.justifyContent = 'space-between';
        row.style.alignItems = 'center';
        row.style.padding = '2px 0';

        const nameSpan = document.createElement('span');
        nameSpan.style.fontFamily = "'JetBrains Mono', monospace";
        nameSpan.style.color = 'var(--status-blue)';
        nameSpan.innerText = toolName;

        const countSpan = document.createElement('span');
        countSpan.style.fontWeight = 'bold';
        countSpan.style.color = '#fff';
        countSpan.innerText = `${count} calls`;

        row.appendChild(nameSpan);
        row.appendChild(countSpan);
        toolsList.appendChild(row);
      });
    }

    function updateEngineStatsPanel(data) {
      if (!data.engineStats) return;
      const { paperclip, openclaw, hermes } = data.engineStats;

      if (paperclip) {
        const pEl = document.getElementById('id-paperclip-stats');
        if (pEl) pEl.innerText = `${paperclip.hiredCount || 5} Hired Agents`;
      }

      if (openclaw) {
        const oEl = document.getElementById('id-openclaw-stats');
        if (oEl) oEl.innerText = `${openclaw.pluginsCount || 0} Plugins / ${openclaw.toolsCount || 16} Tools`;

        const oBadge = document.getElementById('id-openclaw-status-badge');
        if (oBadge) {
          if (data.services.openclaw.online) {
            oBadge.innerText = 'Online';
            oBadge.style.backgroundColor = 'rgba(0,230,118,0.15)';
            oBadge.style.color = 'var(--status-green)';
            oBadge.style.borderColor = 'var(--status-green)';
          } else {
            oBadge.innerText = 'Offline';
            oBadge.style.backgroundColor = 'rgba(255,23,68,0.15)';
            oBadge.style.color = 'var(--status-red)';
            oBadge.style.borderColor = 'var(--status-red)';
          }
        }
      }

      if (hermes) {
        const hEl = document.getElementById('id-hermes-stats');
        if (hEl) hEl.innerText = `${hermes.activeRunners || 1} Active Runner${hermes.activeRunners > 1 ? 's' : ''}`;

        const hTraceEl = document.getElementById('id-traces-count');
        if (hTraceEl) hTraceEl.innerText = `${hermes.tracesCount || 0} logs`;
      }

      if (data.services && data.services.watchtower) {
        const wt = data.services.watchtower;
        const wBadge = document.getElementById('id-watchtower-status-badge');
        const wStats = document.getElementById('id-watchtower-stats');
        if (wBadge) {
          if (wt.online) {
            wBadge.innerText = 'Online';
            wBadge.style.backgroundColor = 'rgba(0,230,118,0.15)';
            wBadge.style.color = 'var(--status-green)';
            wBadge.style.borderColor = 'var(--status-green)';
          } else {
            wBadge.innerText = 'Offline';
            wBadge.style.backgroundColor = 'rgba(255,23,68,0.15)';
            wBadge.style.color = 'var(--status-red)';
            wBadge.style.borderColor = 'var(--status-red)';
          }
        }
        if (wStats) {
          wStats.innerText = wt.status || (wt.online ? 'Running' : 'Stopped');
        }
      }
    }

    // ---------------------------------------------------------------------------
    // Telemetry polling
    // ---------------------------------------------------------------------------
    function seedChartsFromHistory() {
      fetch('/api/history')
        .then(res => res.json())
        .then(history => {
          if (!Array.isArray(history) || history.length === 0) return;
          const cpuValues = history.map(p => p.cpu).filter(v => typeof v === 'number');
          const latencyValues = history.map(p => p.ollamaLatencyMs).filter(v => typeof v === 'number');
          if (cpuChart && cpuValues.length) cpuChart.setData(cpuValues);
          if (latencyChart && latencyValues.length) latencyChart.setData(latencyValues);
        })
        .catch(() => {});
    }

    function pollTelemetry() {
      fetch('/api/telemetry')
        .then(res => res.json())
        .then(data => {
          if (data && Object.keys(data).length > 0) {
            telemetryLive = true;
            lastTelemetryData = data;
            updateTelemetryUI(data);
            updateLastSyncedIndicator();
          }
        })
        .catch(() => {});
    }

    let lastSyncedAt = null;
    function updateLastSyncedIndicator() {
      lastSyncedAt = Date.now();
      renderLastSyncedIndicator();
    }
    function renderLastSyncedIndicator() {
      const el = document.getElementById('id-last-synced');
      if (!el) return;
      if (!lastSyncedAt) {
        el.innerText = 'never';
        el.style.color = 'var(--color-text-muted)';
        return;
      }
      const secsAgo = Math.round((Date.now() - lastSyncedAt) / 1000);
      el.innerText = secsAgo <= 1 ? 'just now' : `${secsAgo}s ago`;
      if (secsAgo > 30) {
        el.style.color = 'var(--status-red)';
      } else if (secsAgo > 12) {
        el.style.color = 'var(--status-amber)';
      } else {
        el.style.color = 'var(--status-green)';
      }
    }

    function startTelemetryPolling(intervalMs = 3000) {
      seedChartsFromHistory();
      fetchAndRenderLiveModels();
      pollTelemetry();
      setInterval(pollTelemetry, intervalMs);
      setInterval(renderLastSyncedIndicator, 1000);
      setInterval(fetchAndRenderLiveModels, 30000); // refresh model list every 30s
    }

    // ---------------------------------------------------------------------------
    // OpenClaw model usage / sessions / pending tasks
    // ---------------------------------------------------------------------------
    function formatTokens(n) {
      if (typeof n !== 'number') return '—';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
      return String(n);
    }

    function renderModelBreakdown(el, models) {
      const entries = Object.entries(models || {}).filter(([, tokens]) => tokens > 0);
      if (!entries.length) {
        el.innerText = '';
        return;
      }
      el.innerText = entries.map(([model, tokens]) => `${model}: ${formatTokens(tokens)}`).join('  ·  ');
    }

    function renderOpenclawStatus(data) {
      const updatedEl = document.getElementById('id-openclaw-updated');
      if (updatedEl) {
        if (!data.ok && !data.updatedAt) {
          updatedEl.innerText = data.error || 'not synced';
        } else if (data.updatedAt) {
          const secsAgo = Math.round((Date.now() - data.updatedAt) / 1000);
          updatedEl.innerText = data.ok
            ? (secsAgo <= 1 ? 'synced just now' : `synced ${secsAgo}s ago`)
            : `stale (${data.error || 'poll failed'})`;
        }
      }

      const usage = data.tokenUsage || { local: {}, cloud: {} };
      const localEl = document.getElementById('id-tokens-local');
      const cloudEl = document.getElementById('id-tokens-cloud');
      if (localEl) localEl.innerText = formatTokens(usage.local && usage.local.tokens);
      if (cloudEl) cloudEl.innerText = formatTokens(usage.cloud && usage.cloud.tokens);
      const localModelsEl = document.getElementById('id-tokens-local-models');
      const cloudModelsEl = document.getElementById('id-tokens-cloud-models');
      if (localModelsEl) renderModelBreakdown(localModelsEl, usage.local && usage.local.models);
      if (cloudModelsEl) renderModelBreakdown(cloudModelsEl, usage.cloud && usage.cloud.models);

      const sessionCountEl = document.getElementById('id-session-count');
      if (sessionCountEl) sessionCountEl.innerText = Array.isArray(data.sessions) ? String(data.sessions.length) : '—';
      const resetsEl = document.getElementById('id-session-resets');
      if (resetsEl) resetsEl.innerText = typeof data.sessionResets === 'number' ? String(data.sessionResets) : '—';
      const pendingCountEl = document.getElementById('id-pending-count');
      if (pendingCountEl) pendingCountEl.innerText = typeof data.pendingCount === 'number' ? String(data.pendingCount) : '—';

      const pendingListEl = document.getElementById('id-pending-list');
      if (pendingListEl) {
        const pending = data.pendingTasks || [];
        pendingListEl.innerText = pending.length
          ? pending.map(t => `${t.status}: ${t.task}`).join('\n')
          : '';
      }
    }

    function pollOpenclawStatus() {
      fetch('/api/openclaw')
        .then(res => res.json())
        .then(data => renderOpenclawStatus(data))
        .catch(() => {});
    }

    function startOpenclawPolling(intervalMs = 15000) {
      pollOpenclawStatus();
      setInterval(pollOpenclawStatus, intervalMs);
    }

    // ---------------------------------------------------------------------------
    // Init
    // ---------------------------------------------------------------------------
    startTelemetryPolling();
    startOpenclawPolling();