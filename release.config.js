module.exports = {
  branches: ["master"],
  plugins: [
    "@semantic-release/commit-analyzer",
    "@semantic-release/release-notes-generator",
    [
      "@semantic-release/changelog",
      {
        changelogFile: "CHANGELOG.md"
      }
    ],
    [
      "@semantic-release/git",
      {
        assets: ["CHANGELOG.md"]
      }
    ],
    [
      "@codedependant/semantic-release-docker",
      {
        dockerTags: ["latest", "{{version}}", "{{major}}-latest", "{{major}}.{{minor}}"],
        dockerImage: "mosswill/erin",
        dockerFile: "Dockerfile",
        dockerPlatform: ["linux/amd64"],
        dockerArgs: {
          RELEASE_DATE: new Date().toISOString(),
        }
      }
    ],
    "@semantic-release/github"
  ]
};
