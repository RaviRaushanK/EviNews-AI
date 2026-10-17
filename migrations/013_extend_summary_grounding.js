'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('summaries', 'prompt_version', { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn('summaries', 'contract_version', { type: Sequelize.STRING(100), allowNull: true });
    await queryInterface.addColumn('summaries', 'input_fingerprint', { type: Sequelize.CHAR(64), allowNull: true });
    await queryInterface.addColumn('summaries', 'generation_status', { type: Sequelize.ENUM('pending', 'succeeded', 'failed'), allowNull: true });
    await queryInterface.addColumn('summaries', 'grounding_status', { type: Sequelize.ENUM('supported', 'partially_supported', 'conflicting', 'unsupported', 'needs_review'), allowNull: false, defaultValue: 'needs_review' });
    await queryInterface.addColumn('summaries', 'structured_output', { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn('summaries', 'context_snapshot', { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addColumn('summaries', 'verification_metadata', { type: Sequelize.JSON, allowNull: true });
    await queryInterface.addIndex('summaries', ['event_id', 'input_fingerprint'], { name: 'idx_summaries_input_unique', unique: true });
    await queryInterface.addIndex('summaries', ['grounding_status'], { name: 'idx_summaries_grounding_status' });
  },
  async down(queryInterface) {
    await queryInterface.removeIndex('summaries', 'idx_summaries_grounding_status');
    await queryInterface.removeIndex('summaries', 'idx_summaries_input_unique');
    for (const field of ['verification_metadata', 'context_snapshot', 'structured_output', 'grounding_status', 'generation_status', 'input_fingerprint', 'contract_version', 'prompt_version']) await queryInterface.removeColumn('summaries', field);
  }
};
