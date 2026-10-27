import React, { useState, useEffect, useCallback } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  InputAdornment,
  IconButton,
  MenuItem,
  Link,
  Alert,
} from '@mui/material';
import { Visibility, VisibilityOff, OpenInNew } from '@mui/icons-material';
import SecretStorageWarning from '../SecretStorageWarning/SecretStorageWarning';
import { saveProviderConfig, loadProviderMeta } from '../../utils/apiKeyStorage';
import { OPENAI_COMPAT_PROVIDERS } from '../../utils/aiProviders';

const TYPE_IDS = Object.keys(OPENAI_COMPAT_PROVIDERS);

/**
 * Configure an OpenAI-compatible provider ("Others"): pick a type, then supply
 * a base URL, API key, and model. Known types prefill the base URL; "custom"
 * lets the user enter one. The config is stored as { apiKey, baseURL, model }
 * via saveProviderConfig; the saved key is never read back into the UI — only
 * its existence (hasKey) is, so it can be replaced but not viewed.
 *
 * @param {string}   [initialType]  Type to preselect (defaults to openrouter)
 * @param {function} onComplete     Called with { provider, baseURL, model } after save
 */
const OthersProviderForm = ({ initialType = 'openrouter', onComplete }) => {
  const [type, setType] = useState(initialType);
  const [baseURL, setBaseURL] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [hasSavedKey, setHasSavedKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const conf = OPENAI_COMPAT_PROVIDERS[type] || OPENAI_COMPAT_PROVIDERS.custom;
  const requiresKey = conf.requiresKey;

  // Load NON-SECRET config for a type (URL/model + whether a key exists),
  // falling back to the type's defaults. The stored key is never fetched, so it
  // can't be displayed — the user can only replace it.
  const hydrateForType = useCallback(async (id) => {
    const c = OPENAI_COMPAT_PROVIDERS[id] || OPENAI_COMPAT_PROVIDERS.custom;
    let meta = null;
    try {
      meta = await loadProviderMeta(id);
    } catch (e) {
      // ignore — fall back to defaults
    }
    setBaseURL(meta?.baseURL || c.baseURL || '');
    setModel(meta?.model || c.placeholderModel || '');
    setHasSavedKey(!!meta?.hasKey);
    setApiKey('');
    setError('');
    setSaved(false);
  }, []);

  useEffect(() => {
    hydrateForType(type);
  }, [type, hydrateForType]);

  const handleTypeChange = (e) => setType(e.target.value);

  // Key-requiring providers are satisfied by either a newly entered key or a
  // previously saved one (blank keeps the existing key on save).
  const canSave =
    !saving &&
    baseURL.trim().length > 0 &&
    model.trim().length > 0 &&
    (!requiresKey || apiKey.trim().length > 0 || hasSavedKey);

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const config = {
        apiKey: apiKey.trim(), // blank → main process preserves the existing key
        baseURL: baseURL.trim().replace(/\/+$/, ''),
        model: model.trim(),
      };
      const result = await saveProviderConfig(type, config);
      if (result?.success === false) {
        setError(result.error || 'Failed to save provider.');
        return;
      }
      setHasSavedKey(true);
      setApiKey('');
      setSaved(true);
      // Never echo the key back to callers.
      setTimeout(() => onComplete?.({ provider: type, baseURL: config.baseURL, model: config.model }), 700);
    } catch (err) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ maxWidth: '100%' }}>
      <Typography variant="subtitle1" fontWeight={700} mb={1}>
        Provider type
      </Typography>
      <TextField
        select
        fullWidth
        value={type}
        onChange={handleTypeChange}
        // This form renders inside both the Settings overlay (z-index 2000–2100)
        // and the onboarding overlay (z-index 9999); MUI's menu defaults to 1300,
        // so raise it above both or the dropdown opens behind the modal.
        SelectProps={{ MenuProps: { sx: { zIndex: 10000 } } }}
        sx={{ mb: 3, '& .MuiOutlinedInput-notchedOutline legend': { width: 0 } }}
      >
        {TYPE_IDS.map((id) => (
          <MenuItem key={id} value={id}>
            {OPENAI_COMPAT_PROVIDERS[id].name}
          </MenuItem>
        ))}
      </TextField>

      {conf.docsUrl ? (
        <Box sx={{ mb: 3 }}>
          <Link
            href={conf.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: 14, color: conf.color, fontWeight: 600 }}
          >
            {requiresKey ? `Get your ${conf.name} API key` : `${conf.name} setup guide`}{' '}
            <OpenInNew sx={{ fontSize: 14 }} />
          </Link>
        </Box>
      ) : null}

      {/* Base URL */}
      <Typography variant="subtitle1" fontWeight={700} mb={1}>
        Base URL
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={1}>
        {type === 'custom'
          ? 'Enter the OpenAI-compatible base URL (it should end in /v1).'
          : 'Prefilled for this provider — change it only if you use a proxy or self-hosted endpoint.'}
      </Typography>
      <TextField
        fullWidth
        value={baseURL}
        onChange={(e) => { setBaseURL(e.target.value); setError(''); }}
        placeholder="https://api.example.com/v1"
        autoComplete="off"
        sx={{ mb: 3, '& .MuiOutlinedInput-notchedOutline legend': { width: 0 } }}
      />

      {/* Model */}
      <Typography variant="subtitle1" fontWeight={700} mb={1}>
        Model
      </Typography>
      <TextField
        fullWidth
        value={model}
        onChange={(e) => { setModel(e.target.value); setError(''); }}
        placeholder={conf.placeholderModel || 'model-name'}
        autoComplete="off"
        helperText="The exact model id this provider expects."
        sx={{ mb: 3, '& .MuiOutlinedInput-notchedOutline legend': { width: 0 } }}
      />

      {/* API key */}
      <Typography variant="subtitle1" fontWeight={700} mb={1}>
        API key{requiresKey ? '' : ' (optional)'}
        {hasSavedKey ? ' — saved' : ''}
      </Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        {hasSavedKey
          ? 'A key is already saved for this provider and is hidden for security. Leave this blank to keep it, or enter a new key to replace it.'
          : requiresKey
            ? 'Encrypted and stored on this device using your OS keychain. It never leaves your machine.'
            : 'Local servers usually need no key — leave blank unless yours requires one.'}
      </Typography>

      <SecretStorageWarning />

      <TextField
        fullWidth
        value={apiKey}
        onChange={(e) => { setApiKey(e.target.value); setError(''); }}
        placeholder={hasSavedKey ? '•••••••••••• (saved — leave blank to keep)' : requiresKey ? 'sk-...' : 'not required'}
        type={showKey ? 'text' : 'password'}
        autoComplete="off"
        error={Boolean(error)}
        helperText={error || ''}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={() => setShowKey((v) => !v)} edge="end" size="small">
                {showKey ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          ),
        }}
        sx={{ mb: 3, '& .MuiOutlinedInput-notchedOutline legend': { width: 0 } }}
      />

      {saved && (
        <Alert severity="success" sx={{ mb: 2 }}>
          {conf.name} configured successfully!
        </Alert>
      )}

      <Button
        variant="contained"
        size="large"
        fullWidth
        onClick={handleSave}
        disabled={!canSave || saved}
        sx={{
          bgcolor: conf.color,
          '&:hover': { bgcolor: conf.color, filter: 'brightness(0.9)' },
          fontWeight: 700,
          py: 1.5,
        }}
      >
        {saving ? 'Saving...' : saved ? 'Saved!' : `Save ${conf.name}`}
      </Button>
    </Box>
  );
};

export default OthersProviderForm;
