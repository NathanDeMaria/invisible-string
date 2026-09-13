import { useParams } from "react-router-dom";

import type { ModelSummary } from "../../services/api";
import { useGetLeaguesQuery } from "../../services/api";

/**
 * The knobs each of a league's models is currently running with.
 *
 * Reads `/api/leagues` rather than a dedicated endpoint: that response
 * already carries one `ModelSummary` per model, and `params` is the release's
 * own record of what it was published with -- there's nothing this page
 * needs that a second request would add.
 */
export function SettingsPage() {
  const { league = "mens" } = useParams();
  const leagues = useGetLeaguesQuery();

  const models = leagues.data?.find((entry) => entry.league === league)?.models;

  if (leagues.isLoading) {
    return <p className="loading">Loading&hellip;</p>;
  }

  if (!models || models.length === 0) {
    return <p className="error">No models published for {league} yet.</p>;
  }

  return (
    <div className="settings-page">
      {models.map((model) => (
        <ModelSettings key={model.name} model={model} />
      ))}
    </div>
  );
}

function ModelSettings({ model }: { model: ModelSummary }) {
  // Sorted so the table has a stable order across renders and models rather
  // than whatever order the release's own JSON happened to store keys in.
  const keys = Object.keys(model.params).sort();

  return (
    <section className="model-settings">
      <h3>
        {model.name}
        {model.is_default && <span className="badge">default</span>}
      </h3>
      <p className="meta">
        {model.predictor_class} &middot; run {model.run_id}
      </p>
      {keys.length === 0 ? (
        <p className="empty">This model has no tunable settings.</p>
      ) : (
        <table className="ratings settings-table">
          <tbody>
            {keys.map((key) => (
              <tr key={key}>
                <th scope="row">{key.replace(/_/g, " ")}</th>
                <td className="num">{String(model.params[key])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
