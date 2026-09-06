import { lazy, Suspense, useState } from 'react';
import Scan from './Scan';
import Setup from './Setup';
import type { RosterUpload } from './roster';
import type { QuizConfig } from './types';

// Lazy: ExcelJS is the bulk of Results' own weight (step.md step 9.4) and
// is only ever needed on this one, rarely-visited screen — splitting it
// out keeps it off the PWA's main precache, which the constantly-used
// Setup/Scan/Review loop shouldn't have to pay for on first load.
const Results = lazy(() => import('./Results'));

function App() {
  const [config, setConfig] = useState<QuizConfig | null>(null);
  // step.md Phase B (plan.md §17) — the workbook Setup parsed and
  // confirmed, if the instructor chose that mode. Mirrors what step 12.14
  // persisted to IndexedDB; Setup itself decides whether that's a fresh
  // upload or a restored one and hands the result up through onStart/
  // onViewResults either way, so App.tsx doesn't need to know which.
  const [rosterUpload, setRosterUpload] = useState<RosterUpload | null>(null);
  const [screen, setScreen] = useState<'scan' | 'results'>('scan');

  if (!config) {
    return (
      <Setup
        onStart={(startedConfig, upload) => {
          setConfig(startedConfig);
          setRosterUpload(upload);
        }}
        // Setup can send you straight to Results for records saved in an
        // earlier session, without passing through the scan screen —
        // carrying whatever roster step 12.14 restored, same as onStart.
        onViewResults={(saved, upload) => {
          setConfig(saved);
          setRosterUpload(upload);
          setScreen('results');
        }}
      />
    );
  }

  if (screen === 'results') {
    return (
      <Suspense fallback={null}>
        <Results
          config={config}
          rosterUpload={rosterUpload}
          onBack={() => setScreen('scan')}
          onReset={() => {
            setConfig(null);
            setRosterUpload(null);
            setScreen('scan');
          }}
        />
      </Suspense>
    );
  }

  return (
    <Scan
      config={config}
      roster={rosterUpload?.roster ?? null}
      onShowResults={() => setScreen('results')}
    />
  );
}

export default App;
