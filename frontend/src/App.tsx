import { useState } from 'react';
import Scan from './Scan';
import Setup from './Setup';
import type { QuizConfig } from './types';

function App() {
  const [config, setConfig] = useState<QuizConfig | null>(null);

  if (!config) {
    return <Setup onStart={setConfig} />;
  }

  return <Scan config={config} />;
}

export default App;
