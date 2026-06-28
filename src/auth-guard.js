import {
  auth,
  db,
  doc,
  getDoc,
  onAuthStateChanged,
  signInWithCustomToken,
  signOut
} from "./firebase.js";

export function getCompanyId() {
  const pathSegment = window.location.pathname.split("/").filter(Boolean)[0];
  const reserved = new Set(["index.html", "src", "css", "js", "assets", "api"]);
  if (pathSegment && !reserved.has(pathSegment.toLowerCase())) {
    return pathSegment.toLowerCase().trim();
  }
  const params = new URLSearchParams(window.location.search);
  const cid = params.get("companyId") || params.get("company") || params.get("cid") || sessionStorage.getItem("tenant_client_id") || "";
  return cid.toLowerCase().trim();
}

function isAiModuleEnabled(company = {}) {
  const modulesEnabled = company.modulesEnabled || {};
  if (Object.prototype.hasOwnProperty.call(modulesEnabled, "ai")) {
    return modulesEnabled.ai === true;
  }
  const features = Array.isArray(company.features) ? company.features : [];
  return features.includes("aiModule");
}

function companyAiCreditsRemaining(company = {}) {
  if (company.aiCreditsRemaining !== undefined && company.aiCreditsRemaining !== null) {
    return Number(company.aiCreditsRemaining || 0);
  }
  return Number(company.aiCredits || 0);
}

async function performSSOLogin(idToken) {
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname.toLowerCase());
  const urls = isLocal ? ["http://localhost:8080/api/sso"] : [];
  urls.push("https://workcosmo.in/api/sso");

  let lastError = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken })
      });
      if (res.ok) {
        const data = await res.json();
        if (data.customToken) return data.customToken;
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("SSO token exchange failed");
}

export function initAuthGuard(onSuccess) {
  const loader = document.getElementById("auth-loader");
  const appShell = document.getElementById("app-shell");

  (async () => {
    const params = new URLSearchParams(window.location.search);
    const ssoToken = params.get("ssoToken");

    if (ssoToken) {
      if (loader) {
        const statusEl = loader.querySelector("p") || loader;
        statusEl.textContent = "Signing in with Space Single Sign-On...";
      }
      try {
        const customToken = await performSSOLogin(ssoToken);
        await signInWithCustomToken(auth, customToken);
        params.delete("ssoToken");
        const newSearch = params.toString();
        const cleanUrl = window.location.pathname + (newSearch ? `?${newSearch}` : "");
        window.history.replaceState({}, document.title, cleanUrl);
      } catch (err) {
        console.error("SSO failed:", err);
        alert("SSO login failed: " + err.message);
      }
    }

    onAuthStateChanged(auth, async (user) => {
      if (!user || user.isAnonymous) {
        const cid = getCompanyId();
        const spaceUrl = cid ? `https://space.workcosmo.in?companyId=${cid}` : "https://space.workcosmo.in";
        window.location.href = spaceUrl;
        return;
      }

      try {
        const userSnap = await getDoc(doc(db, "users", user.uid));
        if (!userSnap.exists()) {
          await signOut(auth);
          window.location.href = "https://space.workcosmo.in";
          return;
        }

        const profile = userSnap.data();
        if (profile.status !== "active") {
          await signOut(auth);
          window.location.href = "https://space.workcosmo.in";
          return;
        }

        const userCompanyId = String(profile.companyId || profile.clientId || profile.subdomain || "").toLowerCase().trim();
        const urlCompanyId = getCompanyId();
        if (urlCompanyId && userCompanyId !== urlCompanyId) {
          await signOut(auth);
          window.location.href = `https://space.workcosmo.in?companyId=${urlCompanyId}`;
          return;
        }

        const companySnap = await getDoc(doc(db, "companies", userCompanyId));
        if (!companySnap.exists()) {
          await signOut(auth);
          window.location.href = "https://space.workcosmo.in";
          return;
        }

        const company = { id: companySnap.id, ...companySnap.data() };
        if (!isAiModuleEnabled(company)) {
          alert("The AI module is not enabled for this workspace.");
          window.location.href = `https://space.workcosmo.in?companyId=${userCompanyId}`;
          return;
        }

        sessionStorage.setItem("tenant_client_id", userCompanyId);
        if (loader) loader.classList.add("hidden");
        if (appShell) appShell.classList.remove("hidden");

        if (typeof onSuccess === "function") {
          onSuccess({
            user,
            profile,
            company,
            companyId: userCompanyId,
            creditsRemaining: companyAiCreditsRemaining(company)
          });
        }
      } catch (error) {
        console.error("Auth guard error:", error);
        await signOut(auth);
        window.location.href = "https://space.workcosmo.in";
      }
    });
  })();
}
