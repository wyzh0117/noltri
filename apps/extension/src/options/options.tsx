import { createRoot } from 'react-dom/client';
import { OptionsView } from './OptionsView';

const container = document.getElementById('root');
if (container) createRoot(container).render(<OptionsView />);
