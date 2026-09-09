// seed-bov-memories.js - Seeds Drisyon Multi-Tenant Memory from BOV projects
const path = require('path');
const DrisyonMemoryEngine = require('./memory-engine');

const memory = new DrisyonMemoryEngine({
  storagePath: path.join(__dirname, 'drisyon-memory.json')
});

console.log('Seeding initial memories from BOV workspace...');

// 1. Core Drisyon Architecture & Invariants (tenant:drisyon_core)
memory.storeMemory({
  tenantId: 'tenant:drisyon_core',
  projectId: '08_drisyon_des',
  category: 'architecture',
  title: 'Drisyon Delivery Engineering System (DES) Blueprint & Principles',
  content: 'Drisyon DES operates on: Client-owned infrastructure (DEC-001); append-only run_step timeline (DEC-002); orthogonal project state vs health (DEC-003); and evidence-backed gate passes (DEC-005). Fast, Standard, and Careful delivery modes govern gates G-Req, G-Design, and G-Ship.',
  tags: ['drisyon_des', 'architecture', 'decisions', 'core'],
  metadata: { source: 'bov/08_drisyon_des/DECISIONS.md' }
});

memory.storeMemory({
  tenantId: 'tenant:drisyon_core',
  projectId: '08_drisyon_des',
  category: 'archetype',
  title: 'WhatsApp Reminder Automation Archetype (v1)',
  content: 'Scheduled WhatsApp reminders driven by spreadsheet/DB source with opt-out keyword STOP, quiet hours 21:00-08:00, 90 days log retention for DPDP compliance, and exponential retry. Uses message_templates contract.',
  tags: ['archetype', 'whatsapp', 'messaging', 'templates'],
  metadata: { source: 'bov/08_drisyon_des/archetypes/whatsapp-reminder-v1' }
});

// 2. Client Project: Indian Railways / BBAT (tenant:client_railways)
memory.storeMemory({
  tenantId: 'tenant:client_railways',
  projectId: '07_BBAT',
  category: 'client_spec',
  title: 'Integrated Biometric & Breath Alcohol Testing (BBAT) System',
  content: 'Integrated AI-enabled biometric cum breath alcohol testing kiosk for Indian Railways Ticket Checking Staff (Hyderabad Division). Hardened roles: System Administrator, Lobby Supervisor, Field Maintenance, and Safety Auditor. Target domain: bbat.mytestbed.tech.',
  tags: ['railways', 'bbat', 'biometrics', 'alcohol_testing', 'safety_compliance'],
  metadata: { client: 'Indian Railways (Hyderabad Division)', path: 'bov/07_BBAT' }
});

// 3. Media & AI Engine: Modular-NeuroClips (tenant:bov_media)
memory.storeMemory({
  tenantId: 'tenant:bov_media',
  projectId: '01_Modular-NeuroClips',
  category: 'media_pipeline',
  title: 'Modular-NeuroClips Engine & Video Rendering Architecture',
  content: 'FastAPI, LangChain, PyTorch Diffusers, and Remotion video rendering pipeline for automated social video clips and curriculum delivery. Verification commands via generate_goalseek.py and npm tests in remotion.',
  tags: ['neuroclips', 'remotion', 'video_ai', 'fastapi', 'diffusers'],
  metadata: { path: 'bov/01_web_applications/Modular-NeuroClips' }
});

// 4. Project Explosion Master Calendar (PEM) & Curriculum
memory.storeMemory({
  tenantId: 'tenant:drisyon_core',
  projectId: '09_PEM',
  category: 'planning',
  title: 'Project Explosion Master Calendar (PEM) Sep-Dec 2026',
  content: 'Daily execution grid for BOV academy tracks, corporate L&D pipelines, admission gates, and technical delivery sprints.',
  tags: ['pem', 'calendar', 'planning', 'sprints'],
  metadata: { path: 'bov/09_PEM' }
});

console.log('Seeding complete! Current memory count:', memory.episodicMemory.length);
