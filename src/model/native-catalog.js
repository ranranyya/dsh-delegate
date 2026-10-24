/**
 * Read the providers already registered with DSH, including their exact model
 * capabilities. This is the source for the delegate settings selector; it does
 * not read or copy endpoints, credentials, or adapter configuration.
 */
export async function listNativeProviderCatalog(llm) {
  if (llm === null || typeof llm?.listProviders !== 'function'
    || typeof llm?.listModels !== 'function'
    || typeof llm?.resolveModelInfo !== 'function') {
    return { providers: [], error: 'native provider catalog is unavailable' };
  }

  let registered;
  try {
    registered = await llm.listProviders();
  } catch {
    return { providers: [], error: 'native provider catalog could not be read' };
  }
  if (!Array.isArray(registered)) return { providers: [], error: 'native provider catalog returned an invalid list' };

  const providers = [];
  for (const entry of registered.slice(0, 64)) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    const name = typeof entry === 'object' && typeof entry?.name === 'string' ? entry.name : id;
    if (typeof id !== 'string' || id === '' || id.startsWith('dsh-delegate:')) continue;
    const provider = { id: id.slice(0, 160), name: String(name ?? id).slice(0, 160), models: [], error: null };

    let listed;
    try {
      listed = await llm.listModels(id);
    } catch {
      provider.error = 'model list could not be read';
      providers.push(provider);
      continue;
    }
    if (!Array.isArray(listed)) {
      provider.error = 'model list returned an invalid response';
      providers.push(provider);
      continue;
    }

    const models = listed.slice(0, 128).map((model) => (typeof model === 'string' ? { id: model } : model));
    const resolved = await Promise.all(models.map(async (model) => {
      const modelId = typeof model?.id === 'string' ? model.id : '';
      if (modelId === '' || modelId.length > 160) return null;
      try {
        const info = await llm.resolveModelInfo(id, modelId);
        if (info === null || typeof info !== 'object') return null;
        const efforts = Array.isArray(info.reasoning?.efforts)
          ? info.reasoning.efforts.map((effort) => (typeof effort === 'string' ? effort : effort?.id))
            .filter((effort) => typeof effort === 'string' && effort !== '').slice(0, 64)
          : [];
        return {
          id: modelId,
          name: String(info.name ?? model.name ?? modelId).slice(0, 160),
          efforts: [...new Set(efforts)],
          contextWindow: Number.isInteger(info.context?.contextWindow) ? info.context.contextWindow : null,
        };
      } catch {
        return null;
      }
    }));
    provider.models = resolved.filter(Boolean);
    if (provider.models.length === 0) provider.error = 'no exact models are available on this provider';
    providers.push(provider);
  }
  return { providers, error: null };
}
