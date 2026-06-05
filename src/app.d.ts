// See https://kit.svelte.dev/docs/types#app
declare global {
  namespace App {
    interface Locals {
      user: {
        login: string;
        role: 'admin' | 'viewer';
      } | null;
    }
    interface PageData {
      user: App.Locals['user'];
    }
  }
}

export {};
