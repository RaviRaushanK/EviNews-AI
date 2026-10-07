'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('contradiction_checks', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the contradiction evaluation'
      },
      claim_id_1: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'claims', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        comment: 'First claim in the canonical claim pair'
      },
      claim_id_2: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'claims', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'RESTRICT',
        comment: 'Second claim in the canonical claim pair'
      },
      input_fingerprint: {
        type: Sequelize.CHAR(64),
        allowNull: false,
        comment: 'SHA-256 fingerprint of the classification input'
      },
      outcome: {
        type: Sequelize.ENUM('direct', 'partial', 'temporal', 'none'),
        allowNull: false,
        comment: 'Classification result, including non-contradictions'
      },
      reason: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Explanation of the classification result'
      },
      model: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: 'Model identifier used for classification'
      },
      prompt_version: {
        type: Sequelize.STRING(100),
        allowNull: false,
        comment: 'Prompt version used for classification'
      },
      checked_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW,
        comment: 'When the claim pair was evaluated'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });

    await queryInterface.addIndex('contradiction_checks', ['claim_id_1'], {
      name: 'idx_contradiction_checks_claim_id_1'
    });
    await queryInterface.addIndex('contradiction_checks', ['claim_id_2'], {
      name: 'idx_contradiction_checks_claim_id_2'
    });
    await queryInterface.addIndex(
      'contradiction_checks',
      ['claim_id_1', 'claim_id_2', 'input_fingerprint'],
      {
        name: 'idx_contradiction_checks_unique',
        unique: true
      }
    );
    await queryInterface.addIndex('contradiction_checks', ['outcome'], {
      name: 'idx_contradiction_checks_outcome'
    });

    await queryInterface.sequelize.query(
      'ALTER TABLE contradiction_checks ' +
      'ADD CONSTRAINT chk_contradiction_checks_claim_order ' +
      'CHECK (claim_id_1 < claim_id_2)'
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable('contradiction_checks');
  }
};
