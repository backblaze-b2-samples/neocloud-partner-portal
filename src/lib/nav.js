// Navigation context — separated from App.jsx to avoid circular imports
// between views (which need useNav) and App (which imports the views).

import { createContext, useContext } from 'react';

export const NavContext = createContext({
  active: 'overview',
  params: {},
  navigate: () => {
    console.warn('navigate() called outside <NavContext.Provider>');
  },
});

export function useNav() {
  return useContext(NavContext);
}
