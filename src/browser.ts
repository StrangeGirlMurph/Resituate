export function hasFileSystemAccess(): boolean {
  if (!window.isSecureContext || window.location.protocol === 'file:') {
    return false;
  }

  return (
    typeof window.showDirectoryPicker === 'function' &&
    typeof window.showOpenFilePicker === 'function' &&
    typeof FileSystemFileHandle !== 'undefined' &&
    'createWritable' in FileSystemFileHandle.prototype
  );
}
