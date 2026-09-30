import { Enter } from './Enter.js';
import { Public } from './Public.js';

export function App() {
  // Tiny path-based router. The marketing public page is slice 4.
  const path = window.location.pathname;
  if (path === '/enter') return <Enter />;
  return <Public />;
}
