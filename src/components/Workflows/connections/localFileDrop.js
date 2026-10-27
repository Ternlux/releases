import React from 'react';
import { message } from 'antd';
import { I, MONO } from '../_designShared';

// Single source of truth for dropping a data file anywhere in the app.
//
// Every drop target (Connections tab, workflow canvas, Workflows tab) has to
// agree on three things or the flow breaks halfway: which extensions are
// accepted, which LocalFileConnectionForm variant imports them, and what the
// overlay promises. They used to be duplicated per target, which is how a
// canvas drop could accept a .parquet and then hand it to the spreadsheet form,
// whose own validator rejects it.

// Extension → LocalFileConnectionForm `fileType`. `.db` means SQLite, which is
// what it is in practice. LanceDB is absent on purpose: it is a directory, not
// a file, so it can only be picked through the native dialog.
const FILE_TYPE_BY_EXT = {
  '.csv': 'spreadsheet', '.xlsx': 'spreadsheet', '.xls': 'spreadsheet',
  '.json': 'json',
  '.parquet': 'parquet',
  '.avro': 'avro',
  '.duckdb': 'duckdb',
  '.sqlite': 'sqlite', '.sqlite3': 'sqlite', '.db': 'sqlite',
};

// The file-backed forms, i.e. the values detectFileType can return plus the
// dialog-only lancedb. Used to decide whether a form type is a local file.
export const LOCAL_FILE_FORM_TYPES = [
  'duckdb', 'sqlite', 'lancedb', 'json', 'spreadsheet', 'parquet', 'avro',
];

export const LOCAL_FILE_MODAL_TITLES = {
  duckdb: 'Connect DuckDB Database',
  sqlite: 'Connect SQLite Database',
  lancedb: 'Connect LanceDB Vector Database',
  json: 'Upload JSON File',
  spreadsheet: 'Add Spreadsheet',
  parquet: 'Upload Parquet File',
  avro: 'Upload Avro File',
};

export const SUPPORTED_DROP_HINT = 'CSV · Excel · JSON · Parquet · Avro · DuckDB · SQLite';

// Only the extension is checked. The browser fills File.type from the OS
// registry, which is empty or wrong for most of these formats (.parquet, .avro
// and .csv all come through inconsistently), so a MIME check rejects valid files.
export const detectFileType = (filename) => {
  const dot = String(filename || '').lastIndexOf('.');
  if (dot < 0) return null;
  return FILE_TYPE_BY_EXT[String(filename).toLowerCase().slice(dot)] || null;
};

// A dropped file this large is a mistake, not an import — the form would sit on
// it for hours before failing.
const MAX_FILE_BYTES = 50 * 1024 * 1024 * 1024; // 50GB

// Pull the importable files out of a drop event, reporting what was skipped.
// Returns [] when there is nothing to import, so callers can bail early.
export const collectDroppableFiles = (event) => {
  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length === 0) return [];

  const oversized = files.filter((f) => f.size > MAX_FILE_BYTES);
  const valid = files.filter((f) => detectFileType(f.name) && f.size <= MAX_FILE_BYTES);

  if (valid.length === 0) {
    message.error(
      oversized.length === files.length
        ? 'File size must be less than 50GB.'
        : 'Unsupported file type. Drop a CSV, Excel, JSON, Parquet, Avro, DuckDB, or SQLite file.',
    );
    return [];
  }
  if (valid.length < files.length) {
    message.warning(
      oversized.length > 0
        ? 'Some files were skipped (unsupported type or over 50GB).'
        : 'Some files were skipped (unsupported type).',
    );
  }
  return valid;
};

// Shared dragover/dragleave behaviour. `onFileDrag` reports whether files (as
// opposed to a dragged node) are over the target, so the caller can show the
// overlay. Drags that carry no files are left alone: the workflow canvas uses
// those to move nodes around.
//
// `disabled` turns the target off while a modal of its own is open. That is not
// cosmetic: antd renders modals in a portal, and React bubbles synthetic events
// through the *React* tree rather than the DOM, so a file dropped on the import
// form inside the modal still reaches the container handler underneath it and
// would restart the very import that is already running.
export const fileDragHandlers = (onFileDrag, disabled = false) => ({
  onDragOver: (event) => {
    if (disabled) return;
    event.preventDefault();
    if (event.dataTransfer.types.includes('Files')) {
      event.dataTransfer.dropEffect = 'copy';
      onFileDrag(true);
    } else {
      event.dataTransfer.dropEffect = 'move';
    }
  },
  onDragLeave: (event) => {
    if (disabled) return;
    event.preventDefault();
    // Only clear when the cursor actually leaves the container, not a child.
    if (!event.currentTarget.contains(event.relatedTarget)) onFileDrag(false);
  },
});

export const FileDropOverlay = ({
  title = 'Drop a file to create a data source',
  hint = SUPPORTED_DROP_HINT,
}) => (
  <div style={{
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(37, 99, 235, 0.08)',
    border: '2px dashed #2563eb',
    zIndex: 1000,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    pointerEvents: 'none',
  }}>
    <div style={{
      textAlign: 'center', backgroundColor: '#fff', padding: 28,
      border: '1px solid #e2e6eb', borderRadius: 8,
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.12)',
    }}>
      {I('import', '#2563eb', 40)}
      <div style={{ fontSize: 14, fontWeight: 600, color: '#111827', margin: '12px 0 6px', letterSpacing: '-0.01em' }}>
        {title}
      </div>
      <div style={{ fontSize: 11, color: '#5a6678', fontFamily: MONO }}>
        {hint}
      </div>
    </div>
  </div>
);
