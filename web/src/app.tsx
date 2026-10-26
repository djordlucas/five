import { useEffect } from 'preact/hooks';
import { LocationProvider, Route, Router } from 'preact-iso';
import { Shell } from './components/Shell';
import { startPolling, stopPolling } from './live';
import { Config } from './pages/Config';
import { Context } from './pages/Context';
import { Inbox } from './pages/Inbox';
import { Libraries } from './pages/Libraries';
import { Activity } from './pages/Activity';
import { Monitor } from './pages/Monitor';
import { NotFound } from './pages/NotFound';
import { Tools } from './pages/Tools';
import { InWorkspace, Workspace } from './pages/Workspace';

// Workspace's tabs: its files, the agent's context, the tools it built and the libraries they share.
const WorkspaceFiles = () => (
  <InWorkspace>
    <Workspace />
  </InWorkspace>
);
const WorkspaceContext = () => (
  <InWorkspace>
    <Context />
  </InWorkspace>
);
const WorkspaceTools = ({ name }: { name?: string }) => (
  <InWorkspace>
    <Tools name={name} />
  </InWorkspace>
);
const WorkspaceLibraries = ({ name }: { name?: string }) => (
  <InWorkspace>
    <Libraries name={name} />
  </InWorkspace>
);

export function App() {
  useEffect(() => {
    startPolling();
    return stopPolling;
  }, []);

  return (
    <LocationProvider>
      <Shell>
        <Router>
          <Route path="/" component={Activity} />
          <Route path="/inbox" component={Inbox} />
          <Route path="/workspace" component={WorkspaceFiles} />
          <Route path="/workspace/context" component={WorkspaceContext} />
          <Route path="/workspace/tools/:name" component={WorkspaceTools} />
          <Route path="/workspace/tools" component={WorkspaceTools} />
          <Route path="/workspace/libraries/:name" component={WorkspaceLibraries} />
          <Route path="/workspace/libraries" component={WorkspaceLibraries} />
          <Route path="/monitor" component={Monitor} />
          <Route path="/config" component={Config} />
          <Route default component={NotFound} />
        </Router>
      </Shell>
    </LocationProvider>
  );
}
