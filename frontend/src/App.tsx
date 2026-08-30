import { lazy, Suspense, useState } from 'react';
import Scan from './Scan';
import Setup from './Setup';
import type { QuizConfig } from './types';

// Lazy: ExcelJS is the bulk of Results' own weight (step.md step 9.4) and
// is only ever needed on this one, rarely-visited screen — splitting it
// out keeps it off the PWA's main precache, which the constantly-used
// Setup/Scan/Review loop shouldn't have to pay for on first load.
const Results = lazy(() => import('./Results'));

function App() {
  const [config, setConfig] = useState<QuizConfig | null>(null);
  const [screen, setScreen] = useState<'scan' | 'results'>('scan');

  if (!config) {
    return <Setup onStart={setConfig} />;
  }

  if (screen === 'results') {
    return (
      <Suspense fallback={null}>
        <Results
          config={config}
          onBack={() => setScreen('scan')}
          onReset={() => {
            setConfig(null);
            setScreen('scan');
          }}
        />
      </Suspense>
    );
  }

  return <Scan config={config} onShowResults={() => setScreen('results')} />;
}

export default App;
