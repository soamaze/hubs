import { generateHubName } from "../utils/name-generation";
import { getReticulumFetchUrl, isLocalClient, connectToReticulum } from "../utils/phoenix-utils";
import jwtDecode from "jwt-decode";
import AuthChannel from "../utils/auth-channel";
import configs from "../utils/configs";

export class SDK {
  constructor(store) {
    this.store = store;
    this.config = {
      feature: configs.feature,
      image: configs.image,
      link: configs.link
    };
  }

  registerPlugin(hook, exports) {
    configs.registerPlugin(hook, exports);
  }

  async signIn(email) {
    const authChannel = new AuthChannel(this.store);
    const socket = await connectToReticulum();
    authChannel.setSocket(socket);
    const { authComplete } = await authChannel.startAuthentication(email);
    await authComplete;

    // TODO: Doing all of this just to determine if the user is an admin seems unnecessary. The auth callback should have the isAdmin flag.
    const retPhxChannel = socket.channel("ret", { hub_id: "index", token: this.store.state.credentials.token });

    const perms = await new Promise(resolve => {
      retPhxChannel.join().receive("ok", () => {
        retPhxChannel.push("refresh_perms_token").receive("ok", ({ perms_token }) => {
          const perms = jwtDecode(perms_token);
          retPhxChannel.leave();
          resolve(perms);
        });
      });
    });

    configs.setIsAdmin(perms.postgrest_role === "ret_admin");
    this.store.update({ credentials: { isAdmin: perms.postgrest_role === "ret_admin" } });
  }

  async verify(authParams) {
    const authChannel = new AuthChannel(this.store);
    const socket = await connectToReticulum();
    authChannel.setSocket(socket);
    await authChannel.verifyAuthentication(authParams.topic, authParams.token, authParams.payload);
  }

  async signOut() {
    this.store.update({ credentials: { token: null, email: null, isAdmin: false } });
    await this.store.resetToRandomDefaultAvatar();
  }

  isAuthenticated() {
    return !!this.getAuthToken();
  }

  isAdmin() {
    return this.store.state.credentials.isAdmin;
  }

  getEmail() {
    return this.store.state.credentials.email;
  }

  getAccountId() {
    return this.store.credentialsAccountId;
  }

  getAuthToken() {
    return this.store.state && this.store.state.credentials.token;
  }

  async fetchJSON(path, { headers, ...options } = {}) {
    const createUrl = getReticulumFetchUrl(path);

    const response = await fetch(createUrl, {
      headers: {
        "content-type": "application/json",
        ...headers
      },
      ...options
    });

    const json = await response.json();

    return json;
  }

  async fetchJSONAuthenticated(path, { headers, ...options } = {}) {
    if (!this.isAuthenticated()) {
      throw new Error("Not Authenticated");
    }

    return this.fetchJSON(path, {
      headers: {
        authorization: `bearer ${this.getAuthToken()}`,
        ...headers
      },
      ...options
    });
  }

  async postJSON(path, payload, options = {}) {
    return this.fetchJSON(path, {
      body: JSON.stringify(payload),
      method: "POST",
      ...options
    });
  }

  async postJSONAuthenticated(path, payload, options = {}) {
    return this.fetchJSONAuthenticated(path, payload, {
      body: JSON.stringify(payload),
      method: "POST",
      ...options
    });
  }

  async createRoom(params = {}) {
    const payload = {
      hub: {
        ...params,
        name: params.name || generateHubName()
      }
    };

    let response;

    if (this.isAuthenticated()) {
      response = await this.postJSONAuthenticated("/api/v1/hubs", payload);

      if (response.error === "invalid_token") {
        // Clear the invalid token from store.
        this.store.update({ credentials: { token: null, email: null } });
        response = undefined;
      }
    }

    if (!response) {
      // Create hub anonymously
      response = await this.postJSON("/api/v1/hubs", payload);
    }

    const creatorAssignmentToken = response.creator_assignment_token;

    if (creatorAssignmentToken) {
      this.store.update({
        creatorAssignmentTokens: [{ hubId: response.hub_id, creatorAssignmentToken: creatorAssignmentToken }]
      });

      // Don't need to store the embed token if there's no creator assignment token, since that means
      // we are the owner and will get the embed token on page load.
      const embedToken = response.embed_token;

      if (embedToken) {
        this.store.update({ embedTokens: [{ hubId: response.hub_id, embedToken: embedToken }] });
      }
    }

    if (isLocalClient()) {
      response.url = new URL(`/hub.html?hub_id=${response.hub_id}`, window.location).href;
    }

    return response;
  }

  async searchMedia(params, cursor = 0) {
    const searchParams = new URLSearchParams();

    for (const paramName in params) {
      searchParams.set(paramName, params[paramName]);
    }

    searchParams.set("cursor", cursor);

    const path = `/api/v1/media/search?${searchParams}`;

    if (this.isAuthenticated()) {
      return this.fetchJSONAuthenticated(path);
    } else {
      return this.fetchJSON(path);
    }
  }

  async getPublicRooms(cursor = 0) {
    return this.searchMedia({ source: "rooms", filter: "public" }, cursor);
  }

  async getFavoriteRooms(cursor = 0) {
    if (!this.isAuthenticated()) {
      throw new Error("Requires authentication.");
    }

    return this.searchMedia(
      {
        source: "favorites",
        type: "rooms",
        user: this.store.credentialsAccountId
      },
      cursor
    );
  }
}
