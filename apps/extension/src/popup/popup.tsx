import { createRoot } from 'react-dom/client';
import { PopupView } from './PopupView';

const container = document.getElementById('root');
if (container) createRoot(container).render(<PopupView />);
