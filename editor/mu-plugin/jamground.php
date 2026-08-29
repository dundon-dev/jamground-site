<?php
/**
 * Jamground mu-plugin.
 *
 * Not installed by Composer or a plugin zip: the shell writes this file into the
 * Playground WASM filesystem at wp-content/mu-plugins/jamground.php after boot
 * (see entry.mjs). The blueprint carries no content.
 *
 * The allowlist below is a content-quality and round-trip mechanism, never a security
 * control — Playground cannot enforce authorization, so least privilege is
 * enforced entirely at the GitHub layer.
 *
 * Four hooks, in this order:
 *   1. allowed_block_types_all   — the inserter allowlist
 *   2. register_block_type_args  — strips supports before registration
 *   3. enqueue_block_assets      — shared block stylesheet
 *   4. admin_init                — suppress the welcome guide
 *
 * No jamground/* block is registered here: this release ships none, so the allowlist below
 * is core blocks only.
 */

// 1. The inserter allowlist. core/list-item is required for core/list to function
// and is never itself an inserter entry, so its absence from the inserter is not asserted.
add_filter('allowed_block_types_all', function () {
    return [
        'core/paragraph',
        'core/heading',
        'core/list',
        'core/list-item',
        'core/image',
        'core/quote',
        'core/code',
        'core/table',
        'core/separator',
    ];
}, 10, 0);

// 2. Strip supports the contract cannot express, before registration — so the controls
// never appear, rather than appearing and being refused at save time.
add_filter('register_block_type_args', function ($args) {
    $args['supports'] = array_merge($args['supports'] ?? [], [
        'color' => false,
        'typography' => false,
        'spacing' => false,
        'border' => false,
        'shadow' => false,
        'className' => false,
        'customClassName' => false,
        'anchor' => false,
        'align' => false,
        'dimensions' => false,
        'position' => false,
        'layout' => false,
        'filter' => false,
    ]);
    return $args;
}, 10, 1);

// 3. The shared block stylesheet. Registered
// with a false source and enqueued on enqueue_block_assets so it loads inside the editor
// canvas as well as the front end preview; a custom property is set so a test can observe
// that this hook actually ran.
add_action('init', function () {
    wp_register_style('jamground-blocks', false);
    wp_add_inline_style('jamground-blocks', 'body{--jp-mu-plugin:present;}');
});
add_action('enqueue_block_assets', function () {
    wp_enqueue_style('jamground-blocks');
});

// 4. Suppress the welcome guide. An editor whose familiarity is the product should not
// be met by WordPress's own onboarding modal.
add_action('admin_init', function () {
    update_user_meta(get_current_user_id(), 'wp_persisted_preferences', [
        'core/edit-post' => ['welcomeGuide' => false],
        'core' => ['welcomeGuide' => false],
    ]);
});
