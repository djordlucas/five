import { useEffect } from 'preact/hooks';
import { LocationProvider, Route, Router } from 'preact-iso';
import { Shell } from './components/Shell';
import { startPolling, stopPolling } from './live';
import { Context } from './pages/Context';
import { Loop } from './pages/Loop';
import { NotFound } from './pages/NotFound';
import { Tools } from './pages/Tools';

export function App() {
  useEffect(() => {
    startPolling();
    return stopPolling;
  }, []);

  return (
    <LocationProvider>
      <Shell>
        <Router>
          <Route path="/" component={Loop} />
          <Route path="/context" component={Context} />
          <Route path="/tools/:name" component={Tools} />
          <Route path="/tools" component={Tools} />
          <Route default component={NotFound} />
        </Router>
      </Shell>
    </LocationProvider>
  );
}
