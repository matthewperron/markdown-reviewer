#!/usr/bin/env bash
# Auto-bump patch version on each commit

set -e

PACKAGE_JSON="package.json"

# Only run if package.json exists and is tracked
if [ ! -f "$PACKAGE_JSON" ]; then
  exit 0
fi

# Read current version
CURRENT_VERSION=$(grep '"version"' "$PACKAGE_JSON" | head -1 | sed 's/.*"version": *"\([^"]*\)".*/\1/')

# Parse major.minor.patch
MAJOR=$(echo "$CURRENT_VERSION" | cut -d. -f1)
MINOR=$(echo "$CURRENT_VERSION" | cut -d. -f2)
PATCH=$(echo "$CURRENT_VERSION" | cut -d. -f3)

# Bump patch
NEW_PATCH=$((PATCH + 1))
NEW_VERSION="${MAJOR}.${MINOR}.${NEW_PATCH}"

# Update package.json
sed -i "s/\"version\": *\"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" "$PACKAGE_JSON"

# Stage the updated package.json
git add "$PACKAGE_JSON"
