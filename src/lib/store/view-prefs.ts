import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { LibraryBrowseMode, LibrarySortOrder } from '../library-browse';

export type ViewMode = 'grid' | 'list' | 'rows';

interface ViewPrefsState {
  shelfViewMode: ViewMode;
  libraryViewMode: ViewMode;
  searchViewMode: ViewMode;
  libraryBrowseMode: LibraryBrowseMode;
  librarySortOrder: LibrarySortOrder;
  setShelfViewMode: (v: ViewMode) => void;
  setLibraryViewMode: (v: ViewMode) => void;
  setSearchViewMode: (v: ViewMode) => void;
  setLibraryBrowseMode: (v: LibraryBrowseMode) => void;
  setLibrarySortOrder: (v: LibrarySortOrder) => void;
}

export const useViewPrefsStore = create<ViewPrefsState>()(
  persist(
    (set) => ({
      shelfViewMode: 'grid',
      libraryViewMode: 'grid',
      searchViewMode: 'grid',
      libraryBrowseMode: 'continuous',
      librarySortOrder: 'desc',
      setShelfViewMode: (v) => set({ shelfViewMode: v }),
      setLibraryViewMode: (v) => set({ libraryViewMode: v }),
      setSearchViewMode: (v) => set({ searchViewMode: v }),
      setLibraryBrowseMode: (v) => set({ libraryBrowseMode: v }),
      setLibrarySortOrder: (v) => set({ librarySortOrder: v }),
    }),
    { name: 'moke-view-prefs' }
  )
);
