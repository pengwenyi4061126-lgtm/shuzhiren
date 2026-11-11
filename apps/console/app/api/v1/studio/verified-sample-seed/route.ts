import { controlPlaneConfig } from "@/lib/control-plane/config";
import { requestContextFrom, requireRole } from "@/lib/control-plane/auth-context";
import { listAssets } from "@/lib/assets";
import { listProducts } from "@/lib/catalog";
import { createCreationProject, listCreationProjects, reviewCreationProjectScript } from "@/lib/creation-projects";
import { isAssetCurrentlyUsable } from "@/lib/shared/asset-eligibility.mjs";
import { verifiedStudioSample, verifiedStudioSampleAssetIds } from "@/lib/verified-studio-sample";

export const dynamic = "force-dynamic";

/** Creates a truthful local reproduction project from the repository's verified 4090 sample package. */
export async function POST(request: Request) {
  try {
    const context = await requestContextFrom(request);
    requireRole(context, ["admin", "operator"]);
    if (!controlPlaneConfig().demoMode) return Response.json({ error: "verified_sample_seed_disabled" }, { status: 404 });

    const existing = (await listCreationProjects(context)).find((project) => project.name === verifiedStudioSample.projectName);
    if (existing) {
      const reviewed = existing.scriptReview ? existing : await reviewCreationProjectScript(context, existing.id);
      if (!reviewed) return Response.json({ error: "verified_sample_project_missing" }, { status: 404 });
      return Response.json({ data: reviewed, created: false });
    }

    const [products, assets] = await Promise.all([listProducts(context), listAssets(context)]);
    const selected = products.flatMap((product) => product.versions.map((version) => ({ product, version })))
      .find(({ version }) => version.status === "approved");
    if (!selected) return Response.json({ error: "verified_sample_product_required" }, { status: 409 });

    const missing = verifiedStudioSampleAssetIds.filter((id) => !assets.some((asset) => asset.id === id && isAssetCurrentlyUsable(asset)));
    if (missing.length) return Response.json({ error: "verified_sample_assets_missing", missing }, { status: 409 });

    const project = await createCreationProject(context, {
      name: verifiedStudioSample.projectName,
      goal: verifiedStudioSample.goal,
      audience: verifiedStudioSample.audience,
      outputMode: verifiedStudioSample.outputMode,
      productVersionId: selected.version.id,
      assetIds: [...verifiedStudioSampleAssetIds],
      script: verifiedStudioSample.script
    });
    const reviewed = await reviewCreationProjectScript(context, project.id);
    if (!reviewed) return Response.json({ error: "verified_sample_review_failed" }, { status: 409 });
    return Response.json({ data: reviewed, created: true }, { status: 201 });
  } catch (error) {
    if (error instanceof Response) return Response.json({ error: error.statusText || "verified_sample_seed_rejected" }, { status: error.status });
    throw error;
  }
}
