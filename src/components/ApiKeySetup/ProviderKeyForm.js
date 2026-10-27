import React, { useState } from 'react';
import {
  Box,
  Typography,
  TextField,
  Button,
  InputAdornment,
  IconButton,
  Paper,
  Chip,
  Link,
  Alert,
  Stepper,
  Step,
  StepLabel,
  StepContent,
} from '@mui/material';
import {
  Visibility,
  VisibilityOff,
  OpenInNew,
} from '@mui/icons-material';
import { saveApiKey } from '../../utils/apiKeyStorage';

// Provider configurations
const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude',
    company: 'Anthropic',
    bgColor: '#fefae0',
    borderColor: '#d4a373',
    keyPrefix: 'sk-ant-',
    keyPlaceholder: 'sk-ant-api03-...',
    docsUrl: 'https://console.anthropic.com/settings/keys',
    logo: () => (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#d4a373" />
        <text x="16" y="22" textAnchor="middle" fontSize="16" fontWeight="bold" fill="#fff">C</text>
      </svg>
    ),
    steps: [
      { label: 'Go to the Anthropic Console', detail: 'Open console.anthropic.com and sign in to your account.' },
      { label: 'Navigate to API Keys', detail: 'Click "Settings" in the left sidebar, then select "API Keys".' },
      { label: 'Create a new key', detail: 'Click "Create Key", give it a name, then copy it — it starts with sk-ant-.' },
    ],
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    company: 'Google',
    bgColor: '#e8f4fd',
    borderColor: '#4285f4',
    keyPrefix: 'AI',
    keyPlaceholder: 'AIza...',
    docsUrl: 'https://aistudio.google.com/app/apikey',
    logo: () => (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#4285f4" />
        <text x="16" y="22" textAnchor="middle" fontSize="16" fontWeight="bold" fill="#fff">G</text>
      </svg>
    ),
    steps: [
      { label: 'Go to Google AI Studio', detail: 'Visit aistudio.google.com and sign in with your Google account.' },
      { label: 'Get API Key', detail: 'Click "Get API key" in the top navigation, then click "Create API key".' },
      { label: 'Copy your key', detail: 'Your API key starts with "AIza" — copy it to use here.' },
    ],
  },
  openai: {
    id: 'chatgpt',
    name: 'ChatGPT',
    company: 'OpenAI',
    bgColor: '#f0fdf4',
    borderColor: '#10a37f',
    keyPrefix: 'sk-',
    keyPlaceholder: 'sk-proj-...',
    docsUrl: 'https://platform.openai.com/api-keys',
    logo: () => (
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="8" fill="#10a37f" />
        <text x="16" y="22" textAnchor="middle" fontSize="16" fontWeight="bold" fill="#fff">O</text>
      </svg>
    ),
    steps: [
      { label: 'Go to OpenAI Platform', detail: 'Open platform.openai.com/api-keys and sign in to your account.' },
      { label: 'Create new secret key', detail: 'Click "+ Create new secret key", give it a name, then copy it.' },
      { label: 'Copy your key', detail: 'The key starts with "sk-proj-" or "sk-" — you won\'t be able to see it again!' },
    ],
  },
};

/**
 * Reusable form for entering an API key for a specific provider
 *
 * @param {string} providerId - 'claude' | 'gemini' | 'openai'
 * @param {function} onComplete - Callback when key is saved successfully
 * @param {boolean} compact - Show compact version without full instructions
 */
const ProviderKeyForm = ({ providerId, onComplete, compact = false }) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const provider = PROVIDERS[providerId];

  if (!provider) {
    return (
      <Alert severity="error">
        Unknown provider: {providerId}
      </Alert>
    );
  }

  const canSave = apiKey.trim().length > 0 && !saving;

  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError('');
    try {
      const result = await saveApiKey(provider.id, apiKey.trim());
      if (result?.success === false) {
        setError(result.error || 'Failed to save API key.');
        return;
      }
      setSaved(true);
      setTimeout(() => onComplete({ provider: provider.id, key: apiKey.trim() }), 900);
    } catch (err) {
      setError(err.message || 'An unexpected error occurred.');
    } finally {
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && canSave) handleSave();
  };

  return (
    <Box sx={{ maxWidth: compact ? '100%' : 660 }}>
      {/* Provider header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 3 }}>
        {provider.logo()}
        <Box>
          <Typography variant="h5" fontWeight={700}>{provider.name}</Typography>
          <Chip
            size="small"
            label={provider.company}
            sx={{ bgcolor: provider.bgColor, color: provider.borderColor, fontWeight: 600, fontSize: 11, mt: 0.5 }}
          />
        </Box>
      </Box>

      {/* Instructions */}
      {!compact && (
        <Paper variant="outlined" sx={{ p: 3, mb: 4, borderRadius: 2 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
            <Typography variant="subtitle1" fontWeight={700}>How to get your API key</Typography>
            <Link
              href={provider.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: 13, color: provider.borderColor, fontWeight: 600 }}
            >
              Open {provider.company} <OpenInNew sx={{ fontSize: 14 }} />
            </Link>
          </Box>
          <Stepper orientation="vertical" nonLinear activeStep={-1}>
            {provider.steps.map((step, i) => (
              <Step key={i} active>
                <StepLabel StepIconProps={{ sx: { color: `${provider.borderColor} !important`, '& .MuiStepIcon-text': { fill: '#fff' } } }}>
                  <Typography variant="body2" fontWeight={600}>{step.label}</Typography>
                </StepLabel>
                <StepContent>
                  <Typography variant="body2" color="text.secondary" mb={1}>{step.detail}</Typography>
                </StepContent>
              </Step>
            ))}
          </Stepper>
        </Paper>
      )}

      {/* Compact instructions link */}
      {compact && (
        <Box sx={{ mb: 3 }}>
          <Link
            href={provider.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            sx={{ display: 'flex', alignItems: 'center', gap: 0.5, fontSize: 14, color: provider.borderColor, fontWeight: 600 }}
          >
            Get your {provider.name} API key <OpenInNew sx={{ fontSize: 14 }} />
          </Link>
        </Box>
      )}

      {/* API Key input */}
      <Typography variant="subtitle1" fontWeight={700} mb={1}>Paste your API key</Typography>
      <Typography variant="body2" color="text.secondary" mb={2}>
        Your key is encrypted and stored securely on this device using your OS keychain. It never leaves your machine.
      </Typography>

      <TextField
        fullWidth
        value={apiKey}
        onChange={(e) => { setApiKey(e.target.value); setError(''); }}
        onKeyDown={handleKeyDown}
        placeholder={provider.keyPlaceholder}
        type={showKey ? 'text' : 'password'}
        autoComplete="off"
        autoFocus
        error={Boolean(error)}
        helperText={error || (compact ? '' : `Keys for ${provider.name} typically start with "${provider.keyPrefix}"`)}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              <IconButton onClick={() => setShowKey(v => !v)} edge="end" size="small">
                {showKey ? <VisibilityOff /> : <Visibility />}
              </IconButton>
            </InputAdornment>
          ),
        }}
        sx={{
          mb: 3,
          '& .MuiOutlinedInput-notchedOutline legend': {
            width: 0,
          }
        }}
      />

      {saved && (
        <Alert severity="success" sx={{ mb: 2 }}>
          API key saved successfully!
        </Alert>
      )}

      <Button
        variant="contained"
        size="large"
        fullWidth
        onClick={handleSave}
        disabled={!canSave || saved}
        sx={{
          bgcolor: provider.borderColor,
          '&:hover': { bgcolor: provider.borderColor, filter: 'brightness(0.9)' },
          fontWeight: 700,
          py: 1.5,
        }}
      >
        {saving ? 'Saving...' : saved ? 'Saved!' : 'Save API Key'}
      </Button>
    </Box>
  );
};

export default ProviderKeyForm;
