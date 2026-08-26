import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto'; // jsdom has no real IndexedDB — needed for db.ts tests
