import type { Photo } from './types';

export interface Project {
  photos: Photo[];
  byId: Map<string, Photo>;
  selection: Set<string>;
  listeners: Set<() => void>;
}

export function createProject(): Project {
  return {
    photos: [],
    byId: new Map(),
    selection: new Set(),
    listeners: new Set(),
  };
}

export function subscribe(project: Project, listener: () => void): void {
  project.listeners.add(listener);
}

function emit(project: Project): void {
  for (const listener of project.listeners) listener();
}

export function setPhotos(
  project: Project,
  photos: Photo[],
  preserveSelection = false,
): void {
  const previous = preserveSelection ? new Set(project.selection) : new Set<string>();
  project.photos = photos;
  project.byId = new Map(photos.map((photo) => [photo.id, photo]));
  project.selection = new Set(
    [...previous].filter((id) => project.byId.has(id)),
  );
  emit(project);
}

export function removePhotos(project: Project, ids: string[]): void {
  const removed = new Set(ids);
  project.photos = project.photos.filter((photo) => !removed.has(photo.id));
  project.byId = new Map(project.photos.map((photo) => [photo.id, photo]));
  for (const id of removed) project.selection.delete(id);
  emit(project);
}

export function selectOnly(project: Project, id: string): void {
  project.selection = new Set([id]);
  emit(project);
}

export function toggle(project: Project, id: string): void {
  if (project.selection.has(id)) project.selection.delete(id);
  else project.selection.add(id);
  emit(project);
}

export function setSelection(project: Project, ids: string[]): void {
  project.selection = new Set(ids);
  emit(project);
}

export function toggleMany(project: Project, ids: string[]): void {
  for (const id of ids) {
    if (project.selection.has(id)) project.selection.delete(id);
    else project.selection.add(id);
  }
  emit(project);
}

export function clearSelection(project: Project): void {
  project.selection.clear();
  emit(project);
}

export function selectAll(project: Project): void {
  project.selection = new Set(project.photos.map((photo) => photo.id));
  emit(project);
}

export function selectedPhotos(project: Project): Photo[] {
  return project.photos.filter((photo) => project.selection.has(photo.id));
}
